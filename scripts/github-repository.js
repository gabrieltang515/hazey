import { spawnSync } from "node:child_process";

// Obtain a GitHub credential through Git's configured helper, never through logs.
async function main() {
  const operation = process.argv[2] || "check";
  const owner = process.argv[3] || "gabrieltang515";
  const name = process.argv[4] || "hazey";
  if (!["check", "create"].includes(operation) || !/^[a-z0-9-]+$/i.test(owner) || !/^[a-z0-9_.-]+$/i.test(name)) throw new Error("Usage: node scripts/github-repository.js check|create OWNER REPO");
  const credential = spawnSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n", encoding: "utf8", timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["pipe", "pipe", "pipe"]
  });
  const token = credential.stdout?.match(/^password=(.+)$/m)?.[1];
  if (credential.status !== 0 || !token) throw new Error("No GitHub HTTPS credential is available. Sign in to GitHub CLI and run gh auth setup-git first.");
  async function api(path, method = "GET", body) {
    let response;
    try { response = await fetch(`https://api.github.com${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000)
    }); } catch { throw new Error("Could not connect to GitHub."); }
    return response;
  }
  const userResponse = await api("/user");
  if (!userResponse.ok) throw new Error(`GitHub sign-in failed (${userResponse.status}).`);
  const user = await userResponse.json();
  if (user.login.toLowerCase() !== owner.toLowerCase()) throw new Error(`Signed in as ${user.login}, but the requested owner is ${owner}.`);
  console.log(`GitHub account confirmed: ${user.login}`);
  console.log(`Commit identity: ${user.name || user.login} <${user.id}+${user.login}@users.noreply.github.com>`);
  if (operation === "check") return;
  const existing = await api(`/repos/${owner}/${name}`);
  if (existing.status === 200) throw new Error(`${owner}/${name} already exists. Refusing to reuse an unrelated repository.`);
  if (existing.status !== 404) throw new Error(`Could not check the repository name (${existing.status}).`);
  const created = await api("/user/repos", "POST", {
    name, private: true, description: "Latest Singapore NEA PSI dashboard and Telegram bot on Cloudflare Workers and D1"
  });
  if (!created.ok) throw new Error(`GitHub repository creation failed (${created.status}).`);
  const repo = await created.json();
  console.log(`Created private repository: ${repo.html_url}`);
  console.log(`Git remote: ${repo.clone_url}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
