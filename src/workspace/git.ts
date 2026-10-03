import * as path from "path";

export type ExecCommand = (
    command: string,
    signal?: AbortSignal
) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;

const GIT_TIMEOUT_MS = 30_000;

export class GitSandbox {
    private readonly workTree: string;
    private readonly gitDir: string;
    private readonly execCommand: ExecCommand;
    private busy = false;
    private initialized = false;
    private baseBranch = "main";

    constructor(workTree: string, gitDir: string, execCommand: ExecCommand) {
        this.workTree = workTree;
        this.gitDir = gitDir;
        this.execCommand = execCommand;
    }

    protected async withLock<T>(fn: () => Promise<T>): Promise<T> {
        if (this.busy) {
            throw new Error(
                "GitSandbox is busy — concurrent git operations are not permitted."
            );
        }
        this.busy = true;
        try {
            return await fn();
        } finally {
            this.busy = false;
        }
    }

    protected async git(args: string[]): Promise<string> {
        const env = [
            `HOME=${this.workTree}`,
            `GIT_DIR=${this.gitDir}`,
            `GIT_WORK_TREE=${this.workTree}`,
            `GIT_PAGER=cat`,
        ].join(" ");

        const command = `${env} git ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`;
        const result = await this.execCommand(command, AbortSignal.timeout(GIT_TIMEOUT_MS));

        if (result.exitCode !== 0) {
            const message = result.stderr ? result.stderr.trim() : "(no stderr)";
            throw new Error(
                `Git command failed (exit ${result.exitCode}): ${message}`
            );
        }

        return result.stdout ? result.stdout.trim() : "";
    }

    protected async sh(command: string): Promise<void> {
        const result = await this.execCommand(command);
        if (result.exitCode !== 0) {
            const message = result.stderr ? result.stderr.trim() : "(no stderr)";
            throw new Error(`Shell command failed (exit ${result.exitCode}): ${message}`);
        }
    }

    protected async checkoutBaseBranch(): Promise<void> {
        const candidates = Array.from(new Set([this.baseBranch, "main", "master"]));
        for (const branch of candidates) {
            try {
                await this.git(["checkout", branch]);
                return;
            } catch (e) {
            }
        }
        throw new Error(`Failed to checkout any base branch. Tried: ${candidates.join(", ")}`);
    }

    public async initializeGitSandboxAsync(): Promise<void> {
        return this.withLock(() => this._initializeGitSandboxAsync());
    }

    public async getGitDiffHead(): Promise<string> {
        return this.withLock(() => this._getGitDiffHead());
    }

    public async getGitDiffHeadNumstat(): Promise<string> {
        return this.withLock(() => this._getGitDiffHeadNumstat());
    }

    public async commitAllChangesAsync(message: string): Promise<string> {
        return this.withLock(() => this._commitAllChangesAsync(message));
    }

    public async restoreCheckpointAsync(
        commitSha: string,
        message: string
    ): Promise<void> {
        return this.withLock(() => this._restoreCheckpointAsync(commitSha, message));
    }

    public async getGitDiffAsync(): Promise<string> {
        return this.withLock(() => this._getGitDiffAsync());
    }

    public async getHeadShaAsync(): Promise<string> {
        return this.withLock(() => this._getHeadShaAsync());
    }

    public async checkoutAsync(branchName: string): Promise<string> {
        return this.withLock(() => this.git(["checkout", branchName]));
    }

    public getBaseBranchName(): string {
        return this.baseBranch;
    }

    private async _initializeGitSandboxAsync(): Promise<void> {
        if (this.initialized) {
            throw new Error(
                "GitSandbox: initializeGitSandboxAsync() has already been called on this instance."
            );
        }
        this.initialized = true;

        const headPath = path.join(this.gitDir, "HEAD");
        const alreadyInitialized = await this.execCommand(`test -f '${headPath}'`)
            .then(r => r.exitCode === 0);

        if (!alreadyInitialized) {
            await this.sh(`mkdir -p '${this.gitDir}' '${this.workTree}'`);

            await this.git(["init"]);

            const excludePath = path.join(this.gitDir, "info", "exclude");
            await this.sh(`mkdir -p '${path.join(this.gitDir, "info")}' && echo 'snapshots/' > '${excludePath}'`);

            await this.git(["config", "user.email", "sandbox@aistudio.local"]);
            await this.git(["config", "user.name", "AI Studio Sandbox"]);
            await this.git(["add", "-A"]);
            await this.git([
                "commit",
                "--allow-empty",
                "-m",
                "Sandbox Baseline (pre-existing files)"
            ]);
        }
        try {
            this.baseBranch = await this.detectBaseBranch();
        } catch (e) {
            this.baseBranch = "main";
        }
    }

    private async detectBaseBranch(): Promise<string> {
        try {
            const current = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
            if (current && current !== "HEAD") {
                return current;
            }
        } catch (e) {
        }

        try {
            const fallback = await this.git(["branch", "--show-current"]);
            if (fallback && fallback !== "HEAD") {
                return fallback;
            }
        } catch (e) {
        }

        try {
            const remoteHead = await this.git(["rev-parse", "--abbrev-ref", "origin/HEAD"]);
            if (remoteHead && remoteHead.startsWith("origin/")) {
                return remoteHead.substring("origin/".length);
            }
        } catch (e) {
        }

        try {
            const nameRev = await this.git(["name-rev", "--name-only", "HEAD"]);
            if (nameRev && !nameRev.includes("~") && !nameRev.includes("^") && nameRev !== "undefined") {
                let cleanName = nameRev;
                if (cleanName.startsWith("remotes/origin/")) {
                    cleanName = cleanName.substring("remotes/origin/".length);
                } else if (cleanName.startsWith("origin/")) {
                    cleanName = cleanName.substring("origin/".length);
                }
                if (cleanName && cleanName !== "HEAD") {
                    return cleanName;
                }
            }
        } catch (e) {
        }

        return "main";
    }

    private async _getGitDiffHead(): Promise<string> {
        return this.git(["diff", "HEAD"]);
    }

    private async _getGitDiffHeadNumstat(): Promise<string> {
        return this.git(["diff", "HEAD", "--numstat"]);
    }

    private async _commitAllChangesAsync(message: string): Promise<string> {
        await this.git(["add", "-A"]);
        await this.git(["commit", "--allow-empty", "-m", message]);
        return this.git(["rev-parse", "HEAD"]);
    }

    private async _restoreCheckpointAsync(
        commitSha: string,
        message: string
    ): Promise<void> {
        const isDirty = await this.git(["status", "--porcelain"]).then(
            (out) => out.length > 0
        );

        if (isDirty) {
            throw new Error(
                "GitSandbox: cannot restore checkpoint — worktree has uncommitted changes. " +
                "Commit or discard them first."
            );
        }

        await this.git(["read-tree", "--reset", "-u", commitSha]);

        await this.git(["clean", "-fd"]);
        await this.git(["add", "-A"]);
        await this.git(["commit", "-m", message]);
    }

    private async _getGitDiffAsync(): Promise<string> {
        return this.git(["diff"]);
    }

    private async _getHeadShaAsync(): Promise<string> {
        return this.git(["rev-parse", "HEAD"]);
    }
}
