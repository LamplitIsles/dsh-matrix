import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { releaseCheck } from "../scripts/release-check.js";
import {
  npmDistTag,
  packedFilePaths,
  packedManifest,
  versionFromTag
} from "../scripts/release-shared.js";

const fixtures: string[] = [];

async function fixture(version = "0.1.0"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-matrix-release-check-"));
  fixtures.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "@lamplitisles/dsh-matrix",
    version,
    repository: {
      type: "git",
      url: "https://github.com/LamplitIsles/dsh-matrix.git"
    },
    publishConfig: {
      registry: "https://registry.npmjs.org",
      access: "public"
    },
    scripts: {}
  }));
  return root;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("release preflight", () => {
  it("accepts matching stable and prerelease tags and chooses their npm channels", async () => {
    const root = await fixture();

    expect(releaseCheck(root, "v0.1.0", false)).toEqual([]);
    expect(versionFromTag("v0.1.0-beta.1")).toBe("0.1.0-beta.1");
    expect(npmDistTag("v0.1.0")).toBe("latest");
    expect(npmDistTag("v0.1.0-beta.1")).toBe("beta");
  });

  it("rejects malformed tags before release metadata can pass", () => {
    expect(() => versionFromTag("release-0.1.0")).toThrow("v<semver>");
    expect(() => versionFromTag("v01.0.0")).toThrow("v<semver>");
    expect(() => versionFromTag("v0.1")).toThrow("v<semver>");
  });

  it("enforces strict prerelease identifiers and accepts build metadata", () => {
    expect(() => versionFromTag("v1.2.3-01")).toThrow("v<semver>");
    expect(() => versionFromTag("v1.2.3-alpha.01")).toThrow("v<semver>");
    expect(versionFromTag("v1.2.3-0")).toBe("1.2.3-0");
    expect(versionFromTag("v1.2.3-alpha01")).toBe("1.2.3-alpha01");
    expect(versionFromTag("v1.2.3+build.1")).toBe("1.2.3+build.1");
    expect(versionFromTag("v1.2.3-alpha01+build.1")).toBe("1.2.3-alpha01+build.1");
    expect(npmDistTag("v1.2.3+build.1")).toBe("latest");
  });

  it("rejects a package version that does not match the tag", async () => {
    const root = await fixture("0.1.1");

    expect(releaseCheck(root, "v0.1.0", false)).toContain(
      "@lamplitisles/dsh-matrix version does not match v0.1.0."
    );
  });

  it("rejects metadata that would publish the wrong package or channel", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "@lamplitisles/not-matrix",
      version: "0.1.0",
      repository: { type: "git", url: "https://example.invalid/repository.git" },
      publishConfig: { access: "restricted" }
    }));

    expect(releaseCheck(root, "v0.1.0", false)).toEqual([
      "package name must be @lamplitisles/dsh-matrix.",
      "@lamplitisles/dsh-matrix has the wrong repository metadata.",
      "@lamplitisles/dsh-matrix must publish publicly to npm."
    ]);
  });

  it("reads npm object-map packed manifests", () => {
    const packed = {
      "@lamplitisles/dsh-matrix": {
        filename: "lamplitisles-dsh-matrix-0.1.0.tgz",
        files: [{ path: "dist/index.js" }, { path: "cordis.patch.yml" }]
      }
    };

    expect(packedFilePaths(packed)).toEqual(new Set(["dist/index.js", "cordis.patch.yml"]));
    expect(packedManifest(packed)?.filename).toBe("lamplitisles-dsh-matrix-0.1.0.tgz");
  });
});
