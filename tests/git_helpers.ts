import { promises as fs } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

/** Run `git <args>` in `cwd` and resolve with combined stdout. Rejects on
 *  non-zero exit (so tests fail fast on setup problems). */
export function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test Author",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test Author",
        GIT_COMMITTER_EMAIL: "test@example.com",
        // Disable global hooks / config for hermetic tests
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: cwd,
      },
    });
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else
        reject(
          new Error(
            `git ${args.join(" ")} exit ${code}: ${Buffer.concat(err).toString("utf8")}`,
          ),
        );
    });
    child.on("error", reject);
  });
}

/** Build a fresh git repo at `root` with one initial commit on `main`,
 *  matching test-author identity. Returns the SHA of the first commit. */
export async function initRepo(root: string): Promise<string> {
  await runGit(root, ["init", "-q", "-b", "main"]);
  await runGit(root, ["config", "user.email", "test@example.com"]);
  await runGit(root, ["config", "user.name", "Test Author"]);
  await runGit(root, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(root, "README.md"), "# Test\n", "utf8");
  await runGit(root, ["add", "README.md"]);
  await runGit(root, ["commit", "-q", "-m", "initial commit"]);
  const sha = (await runGit(root, ["rev-parse", "HEAD"])).trim();
  return sha;
}

/** Append text to a file and commit it. Returns the new HEAD sha. */
export async function commitFile(
  root: string,
  relPath: string,
  content: string,
  message: string,
): Promise<string> {
  const full = path.join(root, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
  await runGit(root, ["add", relPath]);
  await runGit(root, ["commit", "-q", "-m", message]);
  return (await runGit(root, ["rev-parse", "HEAD"])).trim();
}
