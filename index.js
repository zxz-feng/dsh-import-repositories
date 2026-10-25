/**
 * dsh-git-tools — Git capabilities for the DeepSeek Harness.
 *
 * The tools run `git` through the Host subprocess service, so they execute in the
 * host process rather than the agent's file sandbox. That matters on Windows:
 * the agent shell cannot negotiate TLS from inside the sandbox, and git does not
 * read the WinINET system proxy, so `fetch`/`pull`/`push` would fail there. This
 * plugin makes those operations work while keeping the agent's own shell fenced.
 *
 * All output is produced with `-z` / explicit formats where possible so it does
 * not depend on the ambient locale.
 *
 * @module dsh-git-tools
 */
import { homedir } from 'node:os';
import { defineTool } from '@deepseek-ai/dsh-tools';

/** Services this plugin consumes. Every service read from `ctx` must be declared here. */
export const inject = ['commands', 'tools', 'subprocess'];

/** Stable Loader identity. */
export const name = 'git-tools';

/** Milliseconds any single git invocation may run. */
const COMMAND_TIMEOUT_MS = 120_000;
/** Milliseconds the network-facing commands may run. */
const NETWORK_TIMEOUT_MS = 300_000;
/** Maximum stdout bytes retained per invocation. */
const OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
/** Milliseconds a git child gets to exit after termination starts. */
const TERMINATE_GRACE_MS = 2_000;

/**
 * Run `git <args>` through the Host subprocess service.
 * @param ctx - context carrying `subprocess`.
 * @param executable - resolved git executable path.
 * @param args - git arguments; never shell-interpreted.
 * @param cwd - repository working directory.
 * @param signal - cancellation.
 * @param maxBytes - stdout cap.
 * @param timeoutMs - time limit for this invocation.
 * @returns exit code, stdout, and stderr.
 */
async function runGit(ctx, executable, args, cwd, signal, maxBytes = OUTPUT_MAX_BYTES, timeoutMs = COMMAND_TIMEOUT_MS) {
	const timeout = AbortSignal.timeout(timeoutMs);
	const combined = AbortSignal.any([signal, timeout]);
	const handle = ctx.subprocess.spawn({
		argv: [executable, ...args],
		cwd,
		stdio: {
			stdin: 'ignore',
			stdout: { maxBytes },
			stderr: { maxBytes: 64 * 1024 },
		},
		graceMs: TERMINATE_GRACE_MS,
		signal: combined,
		// Keep a missing credential from ever reaching an interactive prompt.
		//
		// GIT_TERMINAL_PROMPT=0 only suppresses git's own stdin question. On
		// Windows the credential is usually requested by a helper (Git Credential
		// Manager), and a helper can open a GUI dialog instead of reading stdin —
		// which shows up as a popup the user did not ask for. Two more variables
		// close that path: an empty GIT_ASKPASS is not consulted when a helper is
		// configured, and GCM_INTERACTIVE=Never makes GCM itself refuse to draw a
		// window and fail instead. Together they turn "wait for a human" into a
		// fast, reportable error.
		//
		// GIT_OPTIONAL_LOCKS=0 keeps read-only commands from taking the index lock,
		// and the bounded output protects the Host from a runaway diff.
		env: {
			GIT_TERMINAL_PROMPT: '0',
			GIT_ASKPASS: '',
			SSH_ASKPASS: '',
			GCM_INTERACTIVE: 'Never',
			GIT_OPTIONAL_LOCKS: '0',
			LC_ALL: 'C',
		},
	});
	const outcome = await handle.done;
	const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false };
	const stderr = handle.collected.stderr?.readFrom(0)?.text ?? '';
	if (combined.aborted) {
		throw new Error(`git ${args[0]}${timeout.aborted ? ` timed out after ${timeoutMs}ms` : ' was aborted'}`);
	}
	return { exitCode: outcome.exitCode, stdout: stdout.text, stderr, truncated: stdout.lossy };
}

/**
 * Reject a failed invocation with git's own diagnostic.
 * @param result - settled invocation facts.
 * @param what - human description for the error.
 * @returns the same result when it exited zero.
 */
function expectOk(result, what) {
	if (result.exitCode !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
		throw new Error(`${what} failed: ${detail}`);
	}
	return result;
}

/**
 * Resolve the working directory for a call: an explicit `cwd` when given,
 * otherwise the Session's own working directory.
 * @param exec - tool execution context.
 * @param args - validated tool arguments.
 * @returns an absolute directory path.
 */
function workingDirectory(exec, args) {
	if (typeof args.cwd === 'string' && args.cwd.trim() !== '') return args.cwd.trim();
	const sessionCwd = exec.agent?.session?.header?.cwd;
	if (typeof sessionCwd === 'string' && sessionCwd !== '') return sessionCwd;
	throw new Error('no working directory: pass `cwd` explicitly, or run this tool in a Session that has one');
}

/**
 * Resolve the repository enclosing a directory.
 * @param ctx - context carrying `subprocess`.
 * @param executable - resolved git executable path.
 * @param cwd - directory to inspect.
 * @param signal - cancellation.
 * @returns the top-level working tree path.
 * @throws when the directory is not inside a git repository.
 */
async function repositoryRoot(ctx, executable, cwd, signal) {
	const result = await runGit(ctx, executable, ['rev-parse', '--show-toplevel'], cwd, signal);
	if (result.exitCode !== 0) {
		throw new Error(`not a git repository: ${cwd}`);
	}
	return result.stdout.trim() || cwd;
}

/** Tool output shape shared by every git tool: one rendered text blob. */
const textOutput = {
	schema: { type: 'string' },
	render: (_args, value) => [{ type: 'text', text: value }],
};

//#region hosting helpers
// Platform detection exists for one reason: credential behaviour differs enough
// that the wrong transport turns a plain push into a blocking dialog.
// A Gitee/Aliyun HTTPS push always demands a username and password, and on
// Windows that prompt is a Git Credential Manager window — which is exactly the
// failure this plugin exists to avoid. SSH either works or fails fast.

/**
 * Hosts where an HTTPS push reliably needs interactive credentials, so SSH is
 * the transport that can succeed unattended.
 */
const SSH_PREFERRED_HOSTS = ['gitee.com', 'gitcode.com', 'codeup.aliyun.com', 'gitlab.com'];

/**
 * Hosts that publish HTTPS URLs which work without a credential prompt for
 * public repositories.
 */
const PUBLIC_CLONE_HOSTS = ['github.com'];

/**
 * Extract the lower-cased host of an HTTPS/SSH git URL.
 * @param url - a git remote URL.
 * @returns the host, or an empty string when it cannot be determined.
 */
function hostOf(url) {
	const text = url.trim();
	// scp-like syntax: git@host:owner/repo.git
	const scp = /^[^@/\s]+@([^:/\s]+):/.exec(text);
	if (scp !== null) return (scp[1] ?? '').toLowerCase();
	try {
		return new URL(text).hostname.toLowerCase();
	} catch {
		return '';
	}
}

/**
 * Convert an HTTPS repository URL to its SSH equivalent on the same host.
 * @param url - an https:// URL.
 * @returns the `git@host:owner/repo(.git)` form, or undefined when the input is
 *   not an HTTPS URL with a usable path.
 */
function httpsToSsh(url) {
	let parsed;
	try {
		parsed = new URL(url.trim());
	} catch {
		return undefined;
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
	const host = parsed.hostname;
	// A port usually means a self-hosted instance with a non-standard SSH setup,
	// so rewriting it here would guess at the wrong endpoint.
	if (parsed.port !== '') return undefined;
	const path = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
	if (path === '') return undefined;
	// Every supported host serves SSH on the standard 22 with the git account.
	return `git@${host}:${path.endsWith('.git') ? path : `${path}.git`}`;
}

/**
 * Describe how a push to this URL will authenticate, so a caller can pick a
 * transport before anything blocks.
 * @param url - a git remote URL.
 * @returns one human sentence, or an empty string for a local path.
 */
function transportNote(url) {
	const text = url.trim();
	if (text === '' || /^(file:\/\/|[A-Za-z]:[\\/]|\/|\.)/.test(text)) return '';
	const host = hostOf(text);
	const isSsh = /^[^@/\s]+@[^:/\s]+:/.test(text) || text.startsWith('ssh://');
	if (isSsh) return `ssh transport to ${host || 'the remote'} (no credential prompt; needs an SSH key)`;
	if (SSH_PREFERRED_HOSTS.includes(host)) {
		return `HTTPS transport to ${host}: this host asks for a username and password on push, which opens a credential prompt. Prefer preferSsh=true`;
	}
	if (PUBLIC_CLONE_HOSTS.includes(host)) return `HTTPS transport to ${host} (works unattended when the repository accepts your stored credential)`;
	return `HTTPS transport to ${host || 'the remote'}`;
}
//#endregion

/**
 * Register the git tools.
 * @param ctx - Host context carrying `subprocess`.
 */
export function apply(ctx) {
	const lifetime = new AbortController();
	ctx.effect(() => () => {
		lifetime.abort();
	});

	let runner;
	/**
	 * Resolve git once for this plugin generation.
	 * @returns the executable path, or null when git is unavailable.
	 */
	const git = () => {
		runner ??= ctx.subprocess
			.resolveExecutable('git', undefined, lifetime.signal)
			.then(
				(executable) => executable ?? null,
				() => null,
			);
		return runner;
	};

	/**
	 * Resolve git and the repository for one call.
	 * @param exec - tool execution context.
	 * @param args - validated tool arguments.
	 * @returns executable, work tree root, and the original directory.
	 */
	const target = async (exec, args) => {
		const executable = await git();
		if (executable === null) throw new Error('git was not found on this Host');
		const cwd = workingDirectory(exec, args);
		const root = await repositoryRoot(ctx, executable, cwd, exec.signal);
		return { executable, root, cwd };
	};

	ctx.tools.register(
		defineTool({
			name: 'git_status',
			description:
				'Report git repository state: current branch, upstream and ahead/behind counts, and every changed path with its staged and unstaged status. Use this before committing. Runs git in the Host process, so it also works when the session shell cannot reach the network.',
			parameters: { cwd: { type: 'string', description: 'Repository directory; defaults to the Session working directory.' } },
			output: textOutput,
			async execute(args, exec) {
				const { executable, root } = await target(exec, args);
				const signal = exec.signal;

				const branch = await runGit(ctx, executable, ['branch', '--show-current'], root, signal);
				const name = branch.stdout.trim();

				const upstream = await runGit(
					ctx,
					executable,
					['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
					root,
					signal,
				);
				const upstreamName = upstream.exitCode === 0 ? upstream.stdout.trim() : '';

				let ahead = '';
				if (upstreamName !== '') {
					const counts = await runGit(
						ctx,
						executable,
						['rev-list', '--left-right', '--count', `${upstreamName}...HEAD`],
						root,
						signal,
					);
					if (counts.exitCode === 0) {
						const [behind, forward] = counts.stdout.trim().split(/\s+/);
						ahead = `ahead ${forward ?? '?'}, behind ${behind ?? '?'} of ${upstreamName}`;
					}
				}

				const status = expectOk(
					await runGit(ctx, executable, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], root, signal),
					'git status',
				);

				const lines = [`branch: ${name === '' ? '(detached HEAD)' : name}`];
				if (ahead !== '') lines.push(ahead);
				if (upstreamName === '') lines.push('no upstream configured');

				const records = status.stdout.split('\0');
				const files = [];
				for (let index = 0; index < records.length; index += 1) {
					const record = records[index];
					if (record === '') continue;
					const code = record.slice(0, 2);
					let path = record.slice(3);
					// A rename or copy record is followed by its source path.
					if (code[0] === 'R' || code[0] === 'C') {
						const source = records[index + 1];
						index += 1;
						if (source !== undefined && source !== '') path = `${source} -> ${path}`;
					}
					files.push(`${code} ${path}`);
				}

				lines.push(files.length === 0 ? 'working tree clean' : `${files.length} changed path(s):`);
				lines.push(...files);
				if (status.truncated) lines.push('(output was truncated)');
				return lines.join('\n');
			},
			presentCall: (args) => ({ card: 'generic', title: 'Git status', kind: 'read', rawInput: args }),
		}),
	);

	ctx.tools.register(
		defineTool({
			name: 'git_diff',
			description:
				'Show a git diff. Defaults to unstaged changes in the working tree; set `staged` for the index, or pass `rev` for a range such as "HEAD~1" or "main...HEAD". Use before committing to review exactly what changed.',
			parameters: {
				cwd: { type: 'string', description: 'Repository directory; defaults to the Session working directory.' },
				staged: { type: 'boolean', description: 'Diff the index instead of the working tree.' },
				rev: { type: 'string', description: 'Revision or range to diff, for example "HEAD~1" or "origin/main...HEAD".' },
				path: { type: 'string', description: 'Limit the diff to this path or pathspec.' },
			},
			output: textOutput,
			async execute(args, exec) {
				const { executable, root } = await target(exec, args);
				const argv = ['diff', '--no-color', '--no-ext-diff'];
				if (args.staged === true) argv.push('--cached');
				if (typeof args.rev === 'string' && args.rev.trim() !== '') argv.push(args.rev.trim());
				if (typeof args.path === 'string' && args.path.trim() !== '') argv.push('--', args.path.trim());
				const result = expectOk(await runGit(ctx, executable, argv, root, exec.signal), 'git diff');
				const text = result.stdout.trim();
				if (text === '') return 'no changes';
				return result.truncated ? `${text}\n\n(diff was truncated)` : text;
			},
			presentCall: (args) => ({ card: 'generic', title: 'Git diff', kind: 'read', rawInput: args }),
		}),
	);

	ctx.tools.register(
		defineTool({
			name: 'git_log',
			description: 'Show recent commits as one line each with the author date, hash, and subject. Use to understand recent history or find a revision to diff against.',
			parameters: {
				cwd: { type: 'string', description: 'Repository directory; defaults to the Session working directory.' },
				limit: { type: 'number', description: 'How many commits to list; defaults to 20, maximum 200.' },
			},
			output: textOutput,
			async execute(args, exec) {
				const { executable, root } = await target(exec, args);
				const requested = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.trunc(args.limit) : 20;
				const limit = Math.min(Math.max(requested, 1), 200);
				const result = expectOk(
					await runGit(
						ctx,
						executable,
						['log', `--max-count=${limit}`, '--date=short', '--pretty=format:%h %ad %an: %s'],
						root,
						exec.signal,
					),
					'git log',
				);
				const text = result.stdout.trim();
				return text === '' ? 'no commits yet' : text;
			},
			presentCall: (args) => ({ card: 'generic', title: 'Git log', kind: 'read', rawInput: args }),
		}),
	);

	ctx.tools.register(
		defineTool({
			name: 'git_stage',
			description:
				'Stage or unstage paths in the git index. Pass `all: true` to stage everything including untracked files, or name explicit paths. Set `unstage: true` to remove paths from the index instead. This never creates a commit.',
			parameters: {
				cwd: { type: 'string', description: 'Repository directory; defaults to the Session working directory.' },
				all: { type: 'boolean', description: 'Stage every change in the repository, including untracked files.' },
				paths: { type: 'array', items: { type: 'string' }, description: 'Repository-relative paths to stage or unstage.' },
				unstage: { type: 'boolean', description: 'Remove the given paths from the index instead of adding them.' },
			},
			output: textOutput,
			async execute(args, exec) {
				const { executable, root } = await target(exec, args);
				const paths = Array.isArray(args.paths) ? args.paths.filter((entry) => typeof entry === 'string' && entry !== '') : [];
				if (args.all !== true && paths.length === 0) {
					throw new Error('pass `all: true` or at least one path in `paths`');
				}
				// `--` separates pathspecs from options, so it has to come AFTER every
				// option: `git add -- --all` treats "--all" as a literal path and fails
				// with "pathspec '--all' did not match any files".
				const argv = [args.unstage === true ? 'reset' : 'add'];
				if (args.all === true && args.unstage !== true) argv.push('--all');
				if (paths.length > 0) argv.push('--', ...paths);
				expectOk(await runGit(ctx, executable, argv, root, exec.signal), `git ${argv[0]}`);

				const status = await runGit(ctx, executable, ['status', '--short'], root, exec.signal);
				return `staged.\n${status.stdout.trim() || '(working tree clean)'}`;
			},
			presentCall: (args) => ({ card: 'generic', title: 'Git stage', kind: 'other', rawInput: args }),
		}),
	);

	ctx.tools.register(
		defineTool({
			name: 'git_commit',
			description:
				'Create a git commit. The commit message is required. By default only already-staged changes are committed; set `all: true` to stage tracked modifications first. Set `amend: true` to replace the previous commit. Creating a commit is a local operation and does not contact a remote.',
			parameters: {
				cwd: { type: 'string', description: 'Repository directory; defaults to the Session working directory.' },
				message: { type: 'string', required: true, description: 'Commit message.' },
				all: { type: 'boolean', description: 'Stage tracked changes before committing.' },
				amend: { type: 'boolean', description: 'Amend the previous commit instead of creating a new one.' },
			},
			output: textOutput,
			async execute(args, exec) {
				const { executable, root } = await target(exec, args);
				const message = typeof args.message === 'string' ? args.message.trim() : '';
				if (message === '') throw new Error('commit message must not be empty');

				if (args.all === true && args.amend !== true) {
					expectOk(await runGit(ctx, executable, ['add', '--all'], root, exec.signal), 'git add');
				}

				const argv = ['commit', '--message', message];
				if (args.amend === true) argv.push('--amend');
				const result = await runGit(ctx, executable, argv, root, exec.signal);
				if (result.exitCode !== 0) {
					const detail = result.stderr.trim() || result.stdout.trim();
					throw new Error(`git commit failed: ${detail}`);
				}

				const head = await runGit(ctx, executable, ['log', '--max-count=1', '--pretty=format:%h %s'], root, exec.signal);
				return `${result.stdout.trim()}\n${head.stdout.trim()}`;
			},
			presentCall: (args) => ({ card: 'generic', title: 'Git commit', kind: 'other', rawInput: args }),
		}),
	);

	ctx.tools.register(
		defineTool({
			name: 'git_push',
			description:
				'Push commits to a remote. This runs in the Host process and therefore works when the sandboxed session shell cannot reach the network. It always uses git\'s default non-forced push; it cannot force-push. Set `setUpstream: true` when the current branch has no upstream yet.',
			parameters: {
				cwd: { type: 'string', description: 'Repository directory; defaults to the Session working directory.' },
				remote: { type: 'string', description: 'Remote name; defaults to "origin".' },
				branch: { type: 'string', description: 'Branch to push; defaults to the current branch.' },
				setUpstream: { type: 'boolean', description: 'Add --set-upstream so a new branch starts tracking the remote.' },
			},
			output: textOutput,
			async execute(args, exec) {
				const { executable, root } = await target(exec, args);
				const remote = typeof args.remote === 'string' && args.remote.trim() !== '' ? args.remote.trim() : 'origin';
				let branch = typeof args.branch === 'string' ? args.branch.trim() : '';
				if (branch === '') {
					const current = expectOk(await runGit(ctx, executable, ['branch', '--show-current'], root, exec.signal), 'git branch');
					branch = current.stdout.trim();
				}
				if (branch === '') throw new Error('no branch to push: the repository is in detached HEAD state; pass `branch` explicitly');

				const argv = ['push', '--porcelain'];
				if (args.setUpstream === true) argv.push('--set-upstream');
				argv.push(remote, branch);
				const result = await runGit(ctx, executable, argv, root, exec.signal, OUTPUT_MAX_BYTES, NETWORK_TIMEOUT_MS);
				if (result.exitCode !== 0) {
					const detail = result.stderr.trim() || result.stdout.trim();
					throw new Error(`git push failed: ${await networkFailure(executable, root, remote, detail, exec.signal)}`);
				}
				return `pushed ${branch} to ${remote}\n${result.stdout.trim()}`;
			},
			presentCall: (args) => ({ card: 'generic', title: 'Git push', kind: 'other', rawInput: args }),
		}),
	);

	ctx.tools.register(
		defineTool({
			name: 'git_fetch',
			description:
				'Fetch refs and objects from a remote without touching the working tree, then report ahead/behind against the upstream. Runs in the Host process, so it works when the sandboxed session shell cannot reach the network. Use it to check whether the remote moved before pulling or pushing.',
			parameters: {
				cwd: { type: 'string', description: 'Repository directory; defaults to the Session working directory.' },
				remote: { type: 'string', description: 'Remote name; defaults to "origin".' },
				prune: { type: 'boolean', description: 'Also delete remote-tracking refs that no longer exist on the remote.' },
			},
			output: textOutput,
			async execute(args, exec) {
				const { executable, root } = await target(exec, args);
				const remote = typeof args.remote === 'string' && args.remote.trim() !== '' ? args.remote.trim() : 'origin';
				const argv = ['fetch', '--porcelain'];
				if (args.prune === true) argv.push('--prune');
				argv.push(remote);
				const result = await runGit(ctx, executable, argv, root, exec.signal, OUTPUT_MAX_BYTES, NETWORK_TIMEOUT_MS);
				if (result.exitCode !== 0) {
					const detail = result.stderr.trim() || result.stdout.trim();
					throw new Error(`git fetch failed: ${await networkFailure(executable, root, remote, detail, exec.signal)}`);
				}

				const upstream = await runGit(
					ctx,
					executable,
					['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
					root,
					exec.signal,
				);
				const lines = [`fetched ${remote}`];
				if (upstream.exitCode === 0) {
					const [behind, forward] = upstream.stdout.trim().split(/\s+/);
					lines.push(`ahead ${forward ?? '?'}, behind ${behind ?? '?'} of upstream`);
				}
				const summary = result.stdout.trim();
				if (summary !== '') lines.push(summary);
				return lines.join('\n');
			},
			presentCall: (args) => ({ card: 'generic', title: 'Git fetch', kind: 'other', rawInput: args }),
		}),
	);

	ctx.tools.register(
		defineTool({
			name: 'git_pull',
			description:
				'Fetch from a remote and integrate the upstream branch into the current branch. Runs in the Host process, so it works when the sandboxed session shell cannot reach the network. Use `rebase: true` to rebase instead of merging; a conflicted result is reported and left for you to resolve.',
			parameters: {
				cwd: { type: 'string', description: 'Repository directory; defaults to the Session working directory.' },
				remote: { type: 'string', description: 'Remote name; defaults to "origin".' },
				branch: { type: 'string', description: 'Remote branch to integrate; defaults to the configured upstream.' },
				rebase: { type: 'boolean', description: 'Rebase local commits instead of merging.' },
			},
			output: textOutput,
			async execute(args, exec) {
				const { executable, root } = await target(exec, args);
				const remote = typeof args.remote === 'string' && args.remote.trim() !== '' ? args.remote.trim() : 'origin';
				const argv = ['pull'];
				if (args.rebase === true) argv.push('--rebase');
				argv.push(remote);
				if (typeof args.branch === 'string' && args.branch.trim() !== '') argv.push(args.branch.trim());
				const result = await runGit(ctx, executable, argv, root, exec.signal, OUTPUT_MAX_BYTES, NETWORK_TIMEOUT_MS);
				if (result.exitCode !== 0) {
					const detail = [result.stdout.trim(), result.stderr.trim()].filter((part) => part !== '').join('\n');
					throw new Error(`git pull failed: ${await networkFailure(executable, root, remote, detail, exec.signal)}`);
				}
				return result.stdout.trim() || 'already up to date';
			},
			presentCall: (args) => ({ card: 'generic', title: 'Git pull', kind: 'other', rawInput: args }),
		}),
	);

	/**
	 * Explain a network failure whose real cause is the transport.
	 *
	 * Gitee and GitCode reject an unattended HTTPS push: the request needs a
	 * username and password, and on Windows git hands that question to a
	 * credential dialog. Nothing in git's own message says so, so the remedy is
	 * appended here rather than left to the caller.
	 *
	 * @param executable - resolved git executable.
	 * @param root - work tree root.
	 * @param remote - remote name that failed.
	 * @param detail - git's own diagnostic.
	 * @param signal - cancellation.
	 * @returns the detail, plus a concrete remedy when one applies.
	 */
	const networkFailure = async (executable, root, remote, detail, signal) => {
		const url = await runGit(ctx, executable, ['remote', 'get-url', remote], root, signal);
		if (url.exitCode !== 0) return detail;
		const remoteUrl = url.stdout.trim();
		const host = hostOf(remoteUrl);
		const overHttps = remoteUrl.startsWith('https://') || remoteUrl.startsWith('http://');
		if (!overHttps || !SSH_PREFERRED_HOSTS.includes(host)) return detail;
		return (
			`${detail}\n\n` +
			`Hint: ${host} asks for a username and password over HTTPS, which cannot be answered unattended.\n` +
			`Repoint this remote at SSH first, then retry:\n` +
			`  git_remote action=set-url name=${remote} url=${remoteUrl} preferSsh=true\n` +
			`  git_push remote=${remote}`
		);
	};

	//#region remote management
	// Without these two tools the agent can only push to a remote somebody else
	// configured. "Push my local project to GitHub/Gitee/GitCode" starts here.

	/**
	 * Read every configured remote and its fetch URL.
	 * @param executable - resolved git executable.
	 * @param root - work tree root.
	 * @param signal - cancellation.
	 * @returns ordered [name, url] pairs.
	 */
	const listRemotes = async (executable, root, signal) => {
		const names = await runGit(ctx, executable, ['remote'], root, signal);
		if (names.exitCode !== 0) return [];
		const result = [];
		for (const name of names.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')) {
			const url = await runGit(ctx, executable, ['remote', 'get-url', name], root, signal);
			result.push([name, url.exitCode === 0 ? url.stdout.trim() : '']);
		}
		return result;
	};

	ctx.tools.register(
		defineTool({
			name: 'git_remote',
			description:
				'List, add, or repoint git remotes. Use this first when a local project has no remote yet: `action: "add"` with a name and url connects it to GitHub, Gitee, or GitCode, then git_push can send the branch. `action: "list"` reports every remote with its URL and how that URL will authenticate. `action: "set-url"` repoints an existing remote. Set `preferSsh: true` on add/set-url to rewrite an HTTPS URL into its SSH form, which is the reliable path for Gitee because its HTTPS push always demands a credential prompt.',
			parameters: {
				cwd: { type: 'string', description: 'Repository directory; defaults to the Session working directory.' },
				action: {
					type: 'string',
					description: 'What to do: "list" (default), "add", or "set-url".',
				},
				name: { type: 'string', description: 'Remote name, for example "origin", "github", "gitee". Defaults to "origin" for add/set-url.' },
				url: { type: 'string', description: 'Remote URL for add/set-url, for example https://gitee.com/you/repo.git or git@github.com:you/repo.git.' },
				preferSsh: { type: 'boolean', description: 'Rewrite an HTTPS url to its SSH form before writing it. Recommended for Gitee and GitCode.' },
			},
			output: textOutput,
			async execute(args, exec) {
				const { executable, root } = await target(exec, args);
				const signal = exec.signal;
				const action = typeof args.action === 'string' && args.action.trim() !== '' ? args.action.trim().toLowerCase() : 'list';

				if (action === 'list') {
					const remotes = await listRemotes(executable, root, signal);
					if (remotes.length === 0) {
						return [
							'no remotes configured',
							'',
							'Connect this repository with:',
							'  git_remote action=add url=https://github.com/you/repo.git',
							'  git_remote action=add url=https://gitee.com/you/repo.git preferSsh=true',
						].join('\n');
					}
					const lines = [`${remotes.length} remote(s):`];
					for (const [name, url] of remotes) {
						const note = transportNote(url);
						lines.push(`  ${name.padEnd(12)} ${url}${note === '' ? '' : `\n               ${note}`}`);
					}
					return lines.join('\n');
				}

				if (action !== 'add' && action !== 'set-url') {
					throw new Error(`unknown action "${action}": expected "list", "add", or "set-url"`);
				}

				const name = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : 'origin';
				// git's own ref rules for a remote name: no whitespace, no path separators.
				if (!/^[A-Za-z0-9._-]+$/.test(name)) {
					throw new Error(`invalid remote name "${name}": use letters, digits, dot, underscore, or dash`);
				}

				const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
				if (rawUrl === '') throw new Error('pass `url` for action "add" or "set-url"');
				// A remote name is not a URL. Catching it here gives a useful message
				// instead of git's "does not appear to be a git repository".
				if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/|[A-Za-z]:[\\/]|\.{1,2}[\\/])/.test(rawUrl)) {
					throw new Error(
						`\`url\` expects a repository URL, not a name: ${rawUrl}\n` +
							'  example: https://github.com/you/repo.git\n' +
							'  example: git@github.com:you/repo.git\n' +
							'Nothing was changed.',
					);
				}

				let url = rawUrl;
				const notes = [];
				if (args.preferSsh === true) {
					const ssh = httpsToSsh(rawUrl);
					if (ssh === undefined) {
						// Already SSH, or a form that cannot be rewritten safely. Say so,
						// and keep the URL the caller gave rather than guessing.
						notes.push(rawUrl.startsWith('https://') || rawUrl.startsWith('http://') ? 'preferSsh: this URL cannot be rewritten (non-standard port or path); kept as given' : 'preferSsh: this URL is already SSH or is a local path; kept as given');
					} else {
						url = ssh;
						notes.push(`preferSsh: rewrote ${rawUrl} -> ${ssh}`);
					}
				}

				const existing = await listRemotes(executable, root, signal);
				const known = existing.map(([remoteName]) => remoteName);

				// `add` on an existing name fails in git; report the truth and the fix
				// instead of silently converting an add into a set-url.
				if (action === 'add' && known.includes(name)) {
					const current = existing.find(([remoteName]) => remoteName === name)?.[1] ?? '';
					throw new Error(
						`remote "${name}" already exists -> ${current}\n` +
							`Use action: "set-url" to repoint it, or pick another name.\nNothing was changed.`,
					);
				}
				if (action === 'set-url' && !known.includes(name)) {
					const body = known.length === 0 ? 'This repository has no remotes.' : `Configured remotes: ${known.join(', ')}`;
					throw new Error(`remote "${name}" does not exist, so there is nothing to repoint.\n${body}\nUse action: "add" first.`);
				}

				const argv = action === 'add' ? ['remote', 'add', name, url] : ['remote', 'set-url', name, url];
				expectOk(await runGit(ctx, executable, argv, root, signal), `git remote ${action}`);

				const report = [
					`${action === 'add' ? 'added' : 'repointed'} remote "${name}" -> ${url}`,
					...notes,
					'',
					`repository: ${root}`,
				];
				const note = transportNote(url);
				if (note !== '') report.push(`transport: ${note}`);
				if (action === 'add') {
					const current = await runGit(ctx, executable, ['branch', '--show-current'], root, signal);
					const branch = current.stdout.trim();
					report.push(
						'',
						branch === ''
							? 'Next: create a branch (git_branch action=create) then push it.'
							: `Next: git_push branch=${branch} setUpstream=true`,
					);
				}
				return report.join('\n');
			},
			presentCall: (args) => ({ card: 'generic', title: 'Git remote', kind: 'other', rawInput: args }),
		}),
	);

	ctx.tools.register(
		defineTool({
			name: 'git_branch',
			description:
				'List, create, switch, rename, or delete git branches. Create a branch before pushing work that should not land on the main branch. Deletion refuses unmerged branches unless `force: true`, so no commits are lost silently. Switching is refused while the working tree has changes that would be overwritten.',
			parameters: {
				cwd: { type: 'string', description: 'Repository directory; defaults to the Session working directory.' },
				action: {
					type: 'string',
					description: 'What to do: "list" (default), "create", "switch", "delete", or "rename".',
				},
				name: { type: 'string', description: 'Branch to create, switch to, delete, or rename.' },
				from: { type: 'string', description: 'Start point for create, for example "main" or a commit hash. Defaults to the current HEAD.' },
				newName: { type: 'string', description: 'New name for action "rename".' },
				force: { type: 'boolean', description: 'For delete: remove the branch even when it has unmerged commits.' },
				remote: { type: 'boolean', description: 'For list: include remote-tracking branches.' },
			},
			output: textOutput,
			async execute(args, exec) {
				const { executable, root } = await target(exec, args);
				const signal = exec.signal;
				const action = typeof args.action === 'string' && args.action.trim() !== '' ? args.action.trim().toLowerCase() : 'list';

				if (action === 'list') {
					const argv = ['branch', '--format=%(refname:short)\t%(upstream:short)\t%(objectname:short)\t%(contents:subject)'];
					if (args.remote === true) argv.push('--all');
					const listed = expectOk(await runGit(ctx, executable, argv, root, signal), 'git branch');
					const rows = listed.stdout.split('\n').map((row) => row.trimEnd()).filter((row) => row !== '');
					if (rows.length === 0) return 'no branches yet: this repository has no commits';
					const current = (await runGit(ctx, executable, ['branch', '--show-current'], root, signal)).stdout.trim();
					const lines = [`${rows.length} branch(es), current: ${current === '' ? '(detached HEAD)' : current}`, ''];
					for (const row of rows) {
						const [branchName, upstream, hash, ...subject] = row.split('\t');
						const marker = branchName === current ? '*' : ' ';
						const track = upstream === undefined || upstream === '' ? '' : ` -> ${upstream}`;
						lines.push(`${marker} ${(branchName ?? '').padEnd(24)} ${(hash ?? '?').padEnd(9)}${track}  ${subject.join('\t')}`);
					}
					return lines.join('\n');
				}

				// Every write path needs a branch name that git will accept.
				const rawName = typeof args.name === 'string' ? args.name.trim() : '';
				if (rawName === '') throw new Error(`action "${action}" requires \`name\``);

				if (action === 'create') {
					const from = typeof args.from === 'string' && args.from.trim() !== '' ? args.from.trim() : '';
					// -c gives git's own ref validation, so a bad name is rejected before
					// anything is created.
					const checked = await runGit(ctx, executable, ['check-ref-format', '--branch', rawName], root, signal);
					if (checked.exitCode !== 0) throw new Error(`git rejects this as a branch name: ${rawName}`);
					const exists = await runGit(ctx, executable, ['rev-parse', '--verify', '--quiet', `refs/heads/${rawName}`], root, signal);
					if (exists.exitCode === 0) {
						throw new Error(`branch "${rawName}" already exists. Switch to it with action: "switch".`);
					}
					const argv = from === '' ? ['branch', rawName] : ['branch', rawName, from];
					expectOk(await runGit(ctx, executable, argv, root, signal), 'git branch');
					return [
						`created branch ${rawName}${from === '' ? '' : ` from ${from}`}`,
						'',
						'The new branch is not checked out and has no upstream yet.',
						`Next: git_push branch=${rawName} setUpstream=true`,
						`      git_branch action=switch name=${rawName}`,
					].join('\n');
				}

				if (action === 'switch') {
					const result = await runGit(ctx, executable, ['checkout', rawName], root, signal);
					if (result.exitCode !== 0) {
						throw new Error(`git checkout failed: ${result.stderr.trim() || result.stdout.trim()}`);
					}
					const upstream = await runGit(ctx, executable, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root, signal);
					const upstreamName = upstream.exitCode === 0 ? upstream.stdout.trim() : '';
					return [
						`switched to ${rawName}`,
						result.stderr.trim(),
						upstreamName === '' ? 'no upstream configured for this branch' : `tracking ${upstreamName}`,
					]
						.filter((line) => line !== '')
						.join('\n');
				}

				if (action === 'delete') {
					const current = (await runGit(ctx, executable, ['branch', '--show-current'], root, signal)).stdout.trim();
					if (current === rawName) {
						throw new Error(`cannot delete "${rawName}": it is the checked-out branch. Switch to another branch first.`);
					}
					// The safe form is -d; -D is only reachable through force.
					const argv = args.force === true ? ['branch', '-D', rawName] : ['branch', '-d', rawName];
					const result = await runGit(ctx, executable, argv, root, signal);
					if (result.exitCode !== 0) {
						const detail = result.stderr.trim() || result.stdout.trim();
						throw new Error(
							`git branch delete failed: ${detail}\n` +
								(args.force === true ? '' : 'The branch has commits that are not merged. Pass force: true to delete it anyway.'),
						);
					}
					return `deleted branch ${rawName}${args.force === true ? ' (forced)' : ''}\n${result.stdout.trim()}`;
				}

				if (action === 'rename') {
					const newName = typeof args.newName === 'string' ? args.newName.trim() : '';
					if (newName === '') throw new Error('action "rename" requires `newName`');
					const checked = await runGit(ctx, executable, ['check-ref-format', '--branch', newName], root, signal);
					if (checked.exitCode !== 0) throw new Error(`git rejects this as a branch name: ${newName}`);
					expectOk(await runGit(ctx, executable, ['branch', '-m', rawName, newName], root, signal), 'git branch -m');
					return `renamed ${rawName} -> ${newName}`;
				}

				throw new Error(`unknown action "${action}": expected "list", "create", "switch", "delete", or "rename"`);
			},
			presentCall: (args) => ({ card: 'generic', title: 'Git branch', kind: 'other', rawInput: args }),
		}),
	);
	//#endregion

	//#region human slash commands
	// These are the `/` commands a person types in the composer. They run the same
	// host-side git path as the tools above, so network operations work here too.
	// A command handler resolves the Session cwd itself because it receives an
	// invocation rather than a tool execution context.

	/** One-line usage help for every command this plugin registers. */
	const USAGE_LINES = [
		'Git commands (git runs on the Host, so network operations work):',
		'',
		'  /git-status [cwd=<dir>]              branch, upstream, ahead/behind, changed files',
		'  /git-diff [--staged] [rev=<rev>] [cwd=<dir>]',
		'  /git-log [n] [cwd=<dir>]             recent commits, default 20',
		'  /git-commit [--all] [--amend] <message> [cwd=<dir>]',
		'  /git-push [--set-upstream] [remote=<name>] [branch=<name>] [cwd=<dir>]',
		'  /git-pull [--rebase] [remote=<name>] [branch=<name>] [cwd=<dir>]',
		'  /git-fetch [--prune] [remote=<name>] [cwd=<dir>]',
		'  /git-name-set name=<name> email=<email> [remote=<url>] [cwd=<dir>]',
		'  /git-tag-show [version] [cwd=<dir>]  list versions (tags), or inspect one',
		'  /git-tag <version> [<remote>] [message=<text>] [rev=<rev>] [cwd=<dir>]',
		'  /git-tag --push [version] [<remote>] [cwd=<dir>]     (no version = all tags)',
		'',
		'Tips:',
		'  - The repository is the Session working directory. If it is not a repo,',
		'    pass cwd=<path> pointing at one, or move the workspace to the repo root.',
		'  - A value that contains spaces must be quoted:',
		'      cwd="C:\\My Projects\\repo"   message="first release"   cwd=C:\\My\\ Projects\\repo',
		'  - git-push never force-pushes.',
		'  - git-name-set writes the identity GLOBALLY (git config --global), so it',
		'    applies to every repository on this machine; the remote= target is written',
		'    only into the chosen repository.',
		'  - git-tag creates a version AND pushes it to the remote (default origin);',
		'    git-tag --push sends tags an earlier attempt left local. GitHub shows a',
		'    version on the Tags/Releases pages only after the tag reaches the remote.',
	].join('\n');

	/** A success result with no side channel. */
	const ok = (text) => ({ kind: 'success', text });
	/** A refusal shown to the person who typed the command. */
	const fail = (text) => ({ kind: 'error', text });

	/**
	 * Split one raw command input into shell-like words.
	 *
	 * The composer sends one flat string, so a path with a space cannot be told
	 * apart from two arguments by splitting on whitespace. Two spellings let a
	 * value keep its spaces:
	 *
	 *   cwd="C:\My Projects\repo"        double quotes
	 *   cwd='C:\My Projects\repo'        single quotes
	 *   cwd=C:\My\ Projects\repo         backslash-escaped spaces
	 *
	 * Quotes are removed and their content kept verbatim; backslashes are only
	 * treated as escapes when they precede a space, a quote, or another backslash,
	 * so a Windows path like C:\Users\me survives unchanged.
	 *
	 * @param rawInput - text following the command name.
	 * @returns the words, with quoting resolved.
	 */
	const tokenize = (rawInput) => {
		const words = [];
		let current = '';
		let started = false;
		let quote = '';
		const text = rawInput.trim();
		for (let index = 0; index < text.length; index += 1) {
			const char = text[index];
			if (quote !== '') {
				if (char === quote) {
					quote = '';
					continue;
				}
				current += char;
				started = true;
				continue;
			}
			// A quote opens a quoted run when it starts a word OR follows `=` as the
			// start of an option value, so `cwd="C:\My Projects\repo"` works while
			// mid-word punctuation like `it's` stays literal — a commit message must
			// never lose an apostrophe.
			if ((char === '"' || char === "'") && (!started || current.endsWith('='))) {
				quote = char;
				started = true;
				continue;
			}
			if (char === '\\' && index + 1 < text.length) {
				const next = text[index + 1];
				// Only these three make a backslash an escape; otherwise it is literal.
				if (next === ' ' || next === '"' || next === "'" || next === '\\') {
					current += next;
					started = true;
					index += 1;
					continue;
				}
			}
			if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
				if (started) {
					words.push(current);
					current = '';
					started = false;
				}
				continue;
			}
			current += char;
			started = true;
		}
		// An unterminated quote keeps what was collected rather than dropping it;
		// the caller then sees the literal text instead of an empty value.
		if (started) words.push(current);
		return words;
	};

	/**
	 * Split one raw command input into flags and a free-text remainder.
	 * @param rawInput - text following the command name.
	 * @param flags - flag names taking no value.
	 * @param valued - option names taking `name=value`.
	 * @returns parsed flags, options, and the remaining words.
	 */
	const parseArgs = (rawInput, flags, valued) => {
		const present = new Set();
		const options = new Map();
		const words = [];
		for (const word of tokenize(rawInput)) {
			if (word === '') continue;
			if (flags.includes(word)) {
				present.add(word);
				continue;
			}
			const separator = word.indexOf('=');
			const key = separator === -1 ? '' : word.slice(0, separator);
			if (valued.includes(key)) {
				options.set(key, word.slice(separator + 1));
				continue;
			}
			words.push(word);
		}
		return { flags: present, options, words };
	};

	/** The Session working directory this invocation belongs to, or an empty string. */
	const invocationCwd = (invocation) => {
		const cwd = invocation.agent?.session?.header?.cwd;
		return typeof cwd === 'string' ? cwd : '';
	};

	/**
	 * Resolve the directory a command should operate in.
	 * @param invocation - the command invocation.
	 * @param options - parsed `name=value` options.
	 * @returns the directory, or undefined when neither source provides one.
	 */
	const commandDirectory = (invocation, options) => {
		const explicit = options.get('cwd');
		if (typeof explicit === 'string' && explicit !== '') return explicit;
		const sessionCwd = invocationCwd(invocation);
		return sessionCwd === '' ? undefined : sessionCwd;
	};

	/**
	 * Resolve git, the work tree root, and the signal for one command invocation.
	 * @param invocation - the command invocation.
	 * @param options - parsed `name=value` options.
	 * @returns resolved host facts, or a refusal to return to the caller.
	 */
	const commandTarget = async (invocation, options) => {
		const executable = await git();
		if (executable === null) return { refusal: fail('git was not found on this Host.') };
		const directory = commandDirectory(invocation, options);
		if (directory === undefined) return { refusal: fail('This Session has no working directory. Pass cwd=<path>.') };
		try {
			const root = await repositoryRoot(ctx, executable, directory, invocation.signal);
			return { executable, root, signal: invocation.signal };
		} catch (error) {
			return {
				refusal: fail(
					`Not a git repository: ${directory}\n` +
						'Pass cwd=<path> pointing at a repository, or move this workspace to the repository root.\n' +
						`Underlying error: ${error instanceof Error ? error.message : String(error)}`,
				),
			};
		}
	};

	/**
	 * Render `branch` plus upstream divergence for a repository root.
	 * @param executable - resolved git executable.
	 * @param root - work tree root.
	 * @param signal - cancellation.
	 * @returns two report lines.
	 */
	const branchReport = async (executable, root, signal) => {
		const branch = await runGit(ctx, executable, ['branch', '--show-current'], root, signal);
		const name = branch.stdout.trim();
		const upstream = await runGit(
			ctx,
			executable,
			['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
			root,
			signal,
		);
		const upstreamName = upstream.exitCode === 0 ? upstream.stdout.trim() : '';
		if (upstreamName === '') {
			return [`branch: ${name === '' ? '(detached HEAD)' : name}`, 'no upstream configured'];
		}
		const counts = await runGit(ctx, executable, ['rev-list', '--left-right', '--count', `${upstreamName}...HEAD`], root, signal);
		if (counts.exitCode !== 0) return [`branch: ${name}`, `upstream: ${upstreamName}`];
		const [behind, ahead] = counts.stdout.trim().split(/\s+/);
		return [`branch: ${name}`, `ahead ${ahead ?? '?'}, behind ${behind ?? '?'} of ${upstreamName}`];
	};

	/**
	 * Report the changed paths of a repository root.
	 * @param executable - resolved git executable.
	 * @param root - work tree root.
	 * @param signal - cancellation.
	 * @returns the status lines, or a refusal-shaped error string.
	 */
	const statusLines = async (executable, root, signal) => {
		const status = await runGit(ctx, executable, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], root, signal);
		if (status.exitCode !== 0) return [`git status failed: ${status.stderr.trim() || `exit ${status.exitCode}`}`];
		const records = status.stdout.split('\0');
		const files = [];
		for (let index = 0; index < records.length; index += 1) {
			const record = records[index];
			if (record === '') continue;
			const code = record.slice(0, 2);
			let path = record.slice(3);
			if (code[0] === 'R' || code[0] === 'C') {
				const source = records[index + 1];
				index += 1;
				if (source !== undefined && source !== '') path = `${source} -> ${path}`;
			}
			files.push(`${code} ${path}`);
		}
		if (files.length === 0) return ['working tree clean'];
		return [`${files.length} changed path(s):`, ...files];
	};

	ctx.effect(function* () {
		yield ctx.commands.register({
			name: 'git-status',
			description: 'Git: branch, upstream divergence, and changed files',
			async handler(invocation) {
				const parsed = parseArgs(invocation.rawInput, [], ['cwd']);
				const resolved = await commandTarget(invocation, parsed.options);
				if (resolved.refusal !== undefined) return resolved.refusal;
				const lines = await branchReport(resolved.executable, resolved.root, resolved.signal);
				lines.push(...(await statusLines(resolved.executable, resolved.root, resolved.signal)));
				return ok(lines.join('\n'));
			},
		});

		yield ctx.commands.register({
			name: 'git-diff',
			description: 'Git: show a diff (working tree by default, --staged for the index)',
			input: { hint: '[--staged] [rev=<rev>] [cwd=<dir>]' },
			async handler(invocation) {
				const parsed = parseArgs(invocation.rawInput, ['--staged'], ['rev', 'cwd']);
				const resolved = await commandTarget(invocation, parsed.options);
				if (resolved.refusal !== undefined) return resolved.refusal;
				const argv = ['diff', '--no-color', '--no-ext-diff'];
				if (parsed.flags.has('--staged')) argv.push('--cached');
				const rev = parsed.options.get('rev');
				if (typeof rev === 'string' && rev !== '') argv.push(rev);
				const result = await runGit(ctx, resolved.executable, argv, resolved.root, resolved.signal);
				if (result.exitCode !== 0) return fail(`git diff failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
				const text = result.stdout.trim();
				if (text === '') return ok('no changes');
				return ok(result.truncated ? `${text}\n\n(diff was truncated)` : text);
			},
		});

		yield ctx.commands.register({
			name: 'git-log',
			description: 'Git: list recent commits (one line each)',
			input: { hint: '[n] [cwd=<dir>]' },
			async handler(invocation) {
				const parsed = parseArgs(invocation.rawInput, [], ['cwd']);
				const resolved = await commandTarget(invocation, parsed.options);
				if (resolved.refusal !== undefined) return resolved.refusal;
				const requested = Number.parseInt(parsed.words[0] ?? '', 10);
				const limit = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 200) : 20;
				const result = await runGit(
					ctx,
					resolved.executable,
					['log', `--max-count=${limit}`, '--date=short', '--pretty=format:%h %ad %an: %s'],
					resolved.root,
					resolved.signal,
				);
				if (result.exitCode !== 0) return fail(`git log failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
				const text = result.stdout.trim();
				return ok(text === '' ? 'no commits yet' : text);
			},
		});

		yield ctx.commands.register({
			name: 'git-commit',
			description: 'Git: create a commit from the index (or --all for tracked changes)',
			input: { hint: '[--all] [--amend] <message> [cwd=<dir>]' },
			async handler(invocation) {
				const parsed = parseArgs(invocation.rawInput, ['--all', '--amend', '-a'], ['cwd']);
				const resolved = await commandTarget(invocation, parsed.options);
				if (resolved.refusal !== undefined) return resolved.refusal;
				const message = parsed.words.join(' ').trim();
				if (message === '') return fail('A commit message is required.\n\n  /git-commit My commit message\n  /git-commit --all My commit message');

				const amend = parsed.flags.has('--amend');
				if (!amend && (parsed.flags.has('--all') || parsed.flags.has('-a'))) {
					const added = await runGit(ctx, resolved.executable, ['add', '--all'], resolved.root, resolved.signal);
					if (added.exitCode !== 0) return fail(`git add failed: ${added.stderr.trim() || `exit ${added.exitCode}`}`);
				}

				const argv = ['commit', '--message', message];
				if (amend) argv.push('--amend');
				const result = await runGit(ctx, resolved.executable, argv, resolved.root, resolved.signal);
				if (result.exitCode !== 0) {
					const detail = result.stderr.trim() || result.stdout.trim();
					return fail(`git commit failed: ${detail}`);
				}
				const head = await runGit(
					ctx,
					resolved.executable,
					['log', '--max-count=1', '--pretty=format:%h %s'],
					resolved.root,
					resolved.signal,
				);
				return ok(`${result.stdout.trim()}\n${head.stdout.trim()}`);
			},
		});

		yield ctx.commands.register({
			name: 'git-push',
			description: 'Git: push the current branch to a remote (never forced)',
			input: { hint: '[--set-upstream] [remote=<name>] [branch=<name>] [cwd=<dir>]' },
			async handler(invocation) {
				const parsed = parseArgs(invocation.rawInput, ['--set-upstream', '-u'], ['remote', 'branch', 'cwd']);
				const resolved = await commandTarget(invocation, parsed.options);
				if (resolved.refusal !== undefined) return resolved.refusal;
				const remote = parsed.options.get('remote') ?? 'origin';
				let branch = parsed.options.get('branch') ?? '';
				if (branch === '') {
					const current = await runGit(ctx, resolved.executable, ['branch', '--show-current'], resolved.root, resolved.signal);
					branch = current.stdout.trim();
				}
				if (branch === '') return fail('Detached HEAD: pass branch=<name> to say what to push.');
				const argv = ['push', '--porcelain'];
				if (parsed.flags.has('--set-upstream') || parsed.flags.has('-u')) argv.push('--set-upstream');
				argv.push(remote, branch);
				const result = await runGit(ctx, resolved.executable, argv, resolved.root, resolved.signal, OUTPUT_MAX_BYTES, NETWORK_TIMEOUT_MS);
				if (result.exitCode !== 0) {
					const detail = result.stderr.trim() || result.stdout.trim();
					return fail(`git push failed: ${detail}`);
				}
				return ok(`pushed ${branch} to ${remote}\n${result.stdout.trim()}`);
			},
		});

		yield ctx.commands.register({
			name: 'git-pull',
			description: 'Git: fetch and integrate the upstream branch',
			input: { hint: '[--rebase] [remote=<name>] [branch=<name>] [cwd=<dir>]' },
			async handler(invocation) {
				const parsed = parseArgs(invocation.rawInput, ['--rebase'], ['remote', 'branch', 'cwd']);
				const resolved = await commandTarget(invocation, parsed.options);
				if (resolved.refusal !== undefined) return resolved.refusal;
				const remote = parsed.options.get('remote') ?? 'origin';
				const argv = ['pull'];
				if (parsed.flags.has('--rebase')) argv.push('--rebase');
				argv.push(remote);
				const branch = parsed.options.get('branch');
				if (typeof branch === 'string' && branch !== '') argv.push(branch);
				const result = await runGit(ctx, resolved.executable, argv, resolved.root, resolved.signal, OUTPUT_MAX_BYTES, NETWORK_TIMEOUT_MS);
				if (result.exitCode !== 0) {
					const detail = [result.stdout.trim(), result.stderr.trim()].filter((part) => part !== '').join('\n');
					return fail(`git pull failed: ${await networkFailure(resolved.executable, resolved.root, remote, detail, resolved.signal)}`);
				}
				return ok(result.stdout.trim() || 'already up to date');
			},
		});

		yield ctx.commands.register({
			name: 'git-fetch',
			description: 'Git: fetch from a remote and report ahead/behind',
			input: { hint: '[--prune] [remote=<name>] [cwd=<dir>]' },
			async handler(invocation) {
				const parsed = parseArgs(invocation.rawInput, ['--prune'], ['remote', 'cwd']);
				const resolved = await commandTarget(invocation, parsed.options);
				if (resolved.refusal !== undefined) return resolved.refusal;
				const remote = parsed.options.get('remote') ?? 'origin';
				const argv = ['fetch', '--porcelain'];
				if (parsed.flags.has('--prune')) argv.push('--prune');
				argv.push(remote);
				const result = await runGit(ctx, resolved.executable, argv, resolved.root, resolved.signal, OUTPUT_MAX_BYTES, NETWORK_TIMEOUT_MS);
				if (result.exitCode !== 0) {
					const detail = result.stderr.trim() || result.stdout.trim();
					return fail(`git fetch failed: ${await networkFailure(resolved.executable, resolved.root, remote, detail, resolved.signal)}`);
				}
				const lines = [`fetched ${remote}`];
				const counts = await runGit(
					ctx,
					resolved.executable,
					['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
					resolved.root,
					resolved.signal,
				);
				if (counts.exitCode === 0) {
					const [behind, ahead] = counts.stdout.trim().split(/\s+/);
					lines.push(`ahead ${ahead ?? '?'}, behind ${behind ?? '?'} of upstream`);
				}
				const summary = result.stdout.trim();
				if (summary !== '') lines.push(summary);
				return ok(lines.join('\n'));
			},
		});

		yield ctx.commands.register({
			name: 'git-name-set',
			description: 'Git: set the global commit identity and optionally repoint this repository at another URL',
			input: { hint: 'name=<name> email=<email> [remote=<url>] [cwd=<dir>]' },
			async handler(invocation) {
				const parsed = parseArgs(invocation.rawInput, [], ['name', 'email', 'remote', 'cwd']);
				const desiredName = (parsed.options.get('name') ?? '').trim();
				const desiredEmail = (parsed.options.get('email') ?? '').trim();
				const remoteUrl = (parsed.options.get('remote') ?? '').trim();

				// ---- validate everything BEFORE writing anything ----
				// A refusal must leave the machine untouched, so no git call happens above this line.
				if (desiredName === '' || desiredEmail === '') {
					return fail(
						[
							'Both name=<name> and email=<email> are required.',
							'',
							'  /git-name-set name=ZhangSan email=zhangsan@example.com',
							'  /git-name-set name=ZhangSan email=zhangsan@example.com remote=https://github.com/zhangsan/repo.git',
							'',
							'Note: the identity is written GLOBALLY (git config --global), so it',
							'applies to every repository on this machine. The remote= target is',
							'written only into the chosen repository.',
						].join('\n'),
					);
				}
				if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(desiredEmail)) {
					return fail(`That does not look like an email address: ${desiredEmail}`);
				}
				if (remoteUrl !== '' && !/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/|[A-Za-z]:[\\/])/.test(remoteUrl)) {
					return fail(
						`remote= expects a URL, not a remote name: ${remoteUrl}\n` +
							`  example: remote=https://github.com/you/repo.git\n` +
							`Nothing was written.`,
					);
				}

				const executable = await git();
				if (executable === null) return fail('git was not found on this Host.');
				const signal = invocation.signal;
				const directory = commandDirectory(invocation, parsed.options);

				// A remote target needs a repository, so resolve it before writing the identity.
				let root;
				if (remoteUrl !== '') {
					if (directory === undefined) {
						return fail('Pass cwd=<dir> (or run this in a Session with a working directory) so the remote target can be applied.\nNothing was written.');
					}
					try {
						root = await repositoryRoot(ctx, executable, directory, signal);
					} catch (error) {
						return fail(
							`Not a git repository: ${directory}\n` +
								`Pass cwd=<path> pointing at a repository, or move this workspace to the repository root.\n` +
								`Underlying error: ${error instanceof Error ? error.message : String(error)}\n` +
								`Nothing was written.`,
						);
					}
				}

				// ---- write, now that every refusal path is behind us ----
				// `git config --global` does not read a repository, so any existing
				// directory works as its working directory.
				const runIn = root ?? directory ?? homedir();
				const failures = [];
				for (const [field, value] of [
					['user.name', desiredName],
					['user.email', desiredEmail],
				]) {
					const result = await runGit(ctx, executable, ['config', '--global', field, value], runIn, signal);
					if (result.exitCode !== 0) failures.push(`git config --global ${field} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
				}
				if (failures.length > 0) return fail(failures.join('\n'));

				const report = [`global identity: ${desiredName} <${desiredEmail}>`];

				if (remoteUrl === '') {
					report.push('', 'remote= was not given, so no repository target was changed.');
					report.push('Add remote=<url> to also point this repository at another remote.');
				} else {
					const existing = await runGit(ctx, executable, ['remote'], root, signal);
					const names = existing.exitCode === 0 ? existing.stdout.trim().split('\n').filter((line) => line !== '') : [];
					const remoteName = names.includes('origin') ? 'origin' : names[0] ?? 'origin';
					const argv = names.length === 0
						? ['remote', 'add', remoteName, remoteUrl]
						: ['remote', 'set-url', remoteName, remoteUrl];
					const applied = await runGit(ctx, executable, argv, root, signal);
					if (applied.exitCode !== 0) {
						return fail(`global identity written, but git ${argv[1]} failed: ${applied.stderr.trim() || `exit ${applied.exitCode}`}`);
					}
					report.push(`remote '${remoteName}' -> ${remoteUrl}`);
					report.push(`repository: ${root}`);
				}

				report.push('', 'Identity applies to new commits; existing commits keep their recorded author.');
				return ok(report.join('\n'));
			},
		});

		//#region version tags
		// A tag names one commit, which is what makes "version v1.0.0" retrievable later.
		// Tags are local until pushed; only then does GitHub show them on its Tags/Releases pages.

		/** Maximum tags listed at once. */
		const TAG_LIST_LIMIT = 50;
		/**
		 * Characters a tag name may not contain, mirroring git's own ref rules.
		 * Inside a character class `[` must be escaped; leaving it raw made the whole
		 * pattern invalid, which silently let whitespace and other illegal names through.
		 */
		const BAD_TAG_CHARS = /[\s~^:?*[\]\\|]|\.\./;

		/**
		 * Reject a tag name git would refuse, before running anything.
		 * @param value - candidate tag name.
		 * @returns a complaint, or undefined when the name looks usable.
		 */
		const tagNameProblem = (value) => {
			if (value === '') return 'a version name is required';
			if (value.length > 200) return 'a version name must be at most 200 characters';
			if (BAD_TAG_CHARS.test(value)) return `a version name may not contain spaces, or any of ~ ^ : ? * [ \\ | or two consecutive dots (got: ${value})`;
			if (value.startsWith('.') || value.startsWith('-')) return `a version name may not start with . or - (got: ${value})`;
			if (value.endsWith('.') || value.endsWith('.lock')) return `a version name may not end with . or .lock (got: ${value})`;
			return undefined;
		};

		/**
		 * Ask git itself whether a tag name is a legal ref, as the authoritative check.
		 * @param executable - resolved git executable.
		 * @param root - work tree root.
		 * @param value - candidate tag name.
		 * @param signal - cancellation.
		 * @returns a complaint, or undefined when git accepts the ref.
		 */
		const gitRefProblem = async (executable, root, value, signal) => {
			const checked = await runGit(ctx, executable, ['check-ref-format', `refs/tags/${value}`], root, signal);
			if (checked.exitCode === 0) return undefined;
			return `git rejects this as a ref name: ${value}`;
		};

		yield ctx.commands.register({
			name: 'git-tag-show',
			description: 'Git: list versions (tags) newest first, or show what one version changed (read-only)',
			input: { hint: '[version] [cwd=<dir>]' },
			async handler(invocation) {
				const parsed = parseArgs(invocation.rawInput, [], ['cwd']);
				const resolved = await commandTarget(invocation, parsed.options);
				if (resolved.refusal !== undefined) return resolved.refusal;
				const { executable, root, signal } = resolved;
				const version = (parsed.words[0] ?? '').trim();

				// With a version this is the read-only detail view; without one it lists
				// every tag. Both paths only read, so nothing here can alter the repository.
				if (version !== '') {
					// Resolve the version first, so an unknown name is reported as such.
					const target = await runGit(ctx, executable, ['show', '--no-patch', '--date=iso', '--pretty=format:%h %an <%ae>%n%ad%n%n%s', version], root, signal);
					if (target.exitCode !== 0) {
						const detail = target.stderr.trim() || `exit ${target.exitCode}`;
						return fail(`Unknown version or commit: ${version}\n${detail}\n\nList available versions with /git-tag-show`);
					}

					// --name-status prints only the changed paths, so the result does not
					// depend on whether the version is an annotated tag, a lightweight tag,
					// or a bare commit (their `show --stat` headers differ in shape).
					// Resolve the commit first: diff-tree does not peel a tag by itself.
					const commit = await runGit(ctx, executable, ['rev-parse', `${version}^{commit}`], root, signal);
					if (commit.exitCode !== 0) {
						return fail(`Unknown version or commit: ${version}\n\nList available versions with /git-tag-show`);
					}
					const changed = await runGit(ctx, executable, ['diff-tree', '--no-commit-id', '--name-status', '-r', commit.stdout.trim()], root, signal);
					if (changed.exitCode !== 0) {
						return fail(`git diff-tree failed: ${changed.stderr.trim() || `exit ${changed.exitCode}`}`);
					}

					const files = changed.stdout.trim() === '' ? [] : changed.stdout.trim().split('\n');
					return ok(
						[
							`version: ${version}`,
							'',
							target.stdout.trim(),
							'',
							files.length === 0 ? '(this version changed no files)' : `changed files (${files.length}):`,
							...files,
						].join('\n'),
					);
				}

				const listed = await runGit(ctx, executable, ['tag', '--list', '--sort=-v:refname'], root, signal);
				if (listed.exitCode !== 0) return fail(`git tag failed: ${listed.stderr.trim() || `exit ${listed.exitCode}`}`);
				const names = listed.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
				if (names.length === 0) {
					return ok(
						[
							'No versions yet. Create one with:',
							'',
							'  /git-tag v1.0.0 message=first-release',
							'',
							'A version is a tag: a name pointing at one commit, so it can be',
							'retrieved later. /git-tag creates the tag and pushes it to the',
							'remote in one step.',
						].join('\n'),
					);
				}

				const shown = names.slice(0, TAG_LIST_LIMIT);
				const lines = [`${names.length} version(s), newest first:`, ''];
				for (const tag of shown) {
					// \t is not allowed in a ref name, so it cannot collide with a tag.
					const facts = await runGit(ctx, executable, ['for-each-ref', '--format=%(objectname:short)\t%(creatordate:short)', `refs/tags/${tag}`], root, signal);
					const fields = facts.exitCode === 0 ? facts.stdout.trim().split('\t') : [];
					const subject = await runGit(ctx, executable, ['log', '--max-count=1', '--pretty=format:%s', tag], root, signal);
					lines.push(`  ${tag.padEnd(16)} ${(fields[0] ?? '?').padEnd(9)} ${(fields[1] ?? '?').padEnd(11)} ${subject.stdout.trim()}`);
				}
				if (names.length > shown.length) lines.push(`  ... and ${names.length - shown.length} more`);
				lines.push('', 'Inspect one:  /git-tag-show <version>        Create and push:  /git-tag <version>');
				return ok(lines.join('\n'));
			},
		});

		yield ctx.commands.register({
			name: 'git-tag',
			description: 'Git: name a commit as a version and push it; --push sends tags that already exist',
			input: { hint: '<version> [<remote>] [message=<text>] [rev=<rev>] [cwd=<dir>]  |  --push [version] [<remote>] [cwd=<dir>]' },
			async handler(invocation) {
				const parsed = parseArgs(invocation.rawInput, ['--push'], ['message', 'rev', 'remote', 'cwd']);
				const pushOnly = parsed.flags.has('--push');
				const words = parsed.words.map((word) => word.trim()).filter((word) => word !== '');
				const version = words[0] ?? '';
				const positionalRemote = words[1];

				// Argument shape is checked BEFORE the repository is resolved. A malformed
				// invocation must be reported as such even when the Session directory is not
				// a git repository, otherwise this command blames the wrong problem.
				if (words.length > 2) {
					return fail(
						[
							`Too many arguments: ${words.map((word) => `"${word}"`).join(' ')}`,
							'',
							'An option value that contains spaces must be quoted:',
							'  message="first release"',
							'',
							'  /git-tag v1.0.0 [<remote>] [message=<text>] [rev=<rev>]',
							'  /git-tag v1.0.0 message=first-release',
							'  /git-tag v1.0.0 message="first release"',
						].join('\n'),
					);
				}

				// Without --push a version is mandatory: this command does not list tags.
				// /git-tag-show is the read-only way to see what already exists.
				if (!pushOnly && version === '') {
					return fail(
						[
							'A version name is required.',
							'',
							'  /git-tag v1.0.0                    create v1.0.0 and push it to origin',
							'  /git-tag v1.0.0 origin message=first-release',
							'  /git-tag --push v1.0.0             push a tag that is still local',
							'  /git-tag --push                    push every local tag',
							'',
							'List existing versions with /git-tag-show',
						].join('\n'),
					);
				}

				const resolved = await commandTarget(invocation, parsed.options);
				if (resolved.refusal !== undefined) return resolved.refusal;
				const { executable, root, signal } = resolved;

				// The push target is the second word, as in `/git-tag v1.0.0 origin`;
				// remote=<name> is accepted as an equivalent spelling. It defaults to the
				// same remote the other network commands use (origin). A positional target
				// is checked against the configured remotes, so a stray word cannot invent
				// a destination that git would then fail (or succeed) against.
				const remotes = await runGit(ctx, executable, ['remote'], root, signal);
				const knownRemotes = remotes.exitCode === 0 ? remotes.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '') : [];
				const remote = (positionalRemote ?? parsed.options.get('remote') ?? 'origin').trim();
				const message = (parsed.options.get('message') ?? '').trim();
				const rev = (parsed.options.get('rev') ?? '').trim();

				if (remote === '') {
					return fail(`The push target must not be empty.\n\n  /git-tag ${version === '' ? '--push' : version} origin`);
				}

				if (positionalRemote !== undefined && !knownRemotes.includes(remote)) {
					return fail(
						[
							`Unknown remote: ${remote}`,
							'',
							knownRemotes.length === 0 ? 'This repository has no remotes configured.' : `Configured remotes: ${knownRemotes.join(', ')}`,
							'',
							'If that word was meant to be part of an option value, quote it:',
							'`message="first release"` keeps the spaces in one value.',
							'',
							`  /git-tag ${version === '' ? '--push' : version} ${knownRemotes[0] ?? 'origin'}`,
						].join('\n'),
					);
				}

				// Validate the name before running anything: a bad name must not reach git,
				// and in create mode it must certainly not reach the network.
				if (version !== '') {
					const problem = tagNameProblem(version);
					if (problem !== undefined) {
						return fail(`Invalid version name: ${problem}\n\n  /git-tag v1.0.0\n  /git-tag v1.0.0 origin message=first-release`);
					}
					const refProblem = await gitRefProblem(executable, root, version, signal);
					if (refProblem !== undefined) {
						return fail(`Invalid version name: ${refProblem}\n\n  /git-tag v1.0.0\n  /git-tag v1.0.0 origin message=first-release`);
					}
				}

				// In push mode the first word is the version, so `/git-tag --push origin`
				// would look for a tag named origin. Name that confusion explicitly.
				if (pushOnly && knownRemotes.includes(version)) {
					const sameName = await runGit(ctx, executable, ['tag', '--list', version], root, signal);
					if (sameName.stdout.trim() === '') {
						return fail(
							[
								`${version} is a configured remote, not a tag.`,
								'',
								`  /git-tag --push remote=${version}        push every tag to it`,
								`  /git-tag --push <version> ${version}     push one tag to it`,
							].join('\n'),
						);
					}
				}

				const report = [];

				// Create first: it is local and fast, and it is what the network step sends.
				if (!pushOnly) {
					const argv = ['tag'];
					if (message !== '') argv.push('--annotate', '--message', message);
					argv.push(version);
					if (rev !== '') argv.push(rev);
					const created = await runGit(ctx, executable, argv, root, signal);
					if (created.exitCode !== 0) {
						return fail(`git tag failed: ${created.stderr.trim() || created.stdout.trim() || `exit ${created.exitCode}`}`);
					}
					const pointer = await runGit(ctx, executable, ['rev-parse', '--short', version], root, signal);
					report.push(`created version ${version} -> ${pointer.stdout.trim()}`);
					report.push(message === '' ? '(lightweight tag: names the commit, no extra message)' : `message: ${message}`);
				}

				// Pushing a bare tag name resolves refs/tags/<name>, so no refspec is needed.
				// `--push` without a version sends every tag, matching `git push --tags`.
				const argv = ['push', '--porcelain'];
				if (version === '') argv.push('--tags', remote);
				else argv.push(remote, version);
				const pushed = await runGit(ctx, executable, argv, root, signal, OUTPUT_MAX_BYTES, NETWORK_TIMEOUT_MS);
				if (pushed.exitCode !== 0) {
					const detail = pushed.stderr.trim() || pushed.stdout.trim();
					if (pushOnly) return fail(`git push failed: ${detail}`);
					// The tag already exists locally, so report that and how to retry the push.
					return fail(
						[
							...report,
							'',
							`git push failed: ${detail}`,
							'',
							'The tag exists locally but is NOT on the remote yet. Retry just the push:',
							`  /git-tag --push ${version}${remote === 'origin' ? '' : ` ${remote}`}`,
						].join('\n'),
					);
				}

				report.push(
					version === '' ? `pushed all tags to ${remote}` : `pushed ${version} to ${remote}`,
					pushed.stdout.trim(),
					'',
					'GitHub now lists this version on the repository Tags and Releases pages.',
				);
				return ok(report.join('\n'));
			},
		});
		//#endregion

		yield ctx.commands.register({
			name: 'git',
			description: 'Git: list the git commands this plugin provides',
			async handler() {
				return ok(USAGE_LINES);
			},
		});
	}, 'git-tools: human commands');
	//#endregion
}
