# `npm pack --json` compatibility evidence

Focused end-to-end verification used Node 24.18.1 and the installed npm 11.16.0.
The second run put a temporary PATH shim in front of that same npm; the shim
delegated the real `npm pack` operation and changed only the top-level JSON from
the npm 11 array form to npm 12's package-name-keyed object form.

In both modes, this command exercised the real package dry run:

```sh
npm pack --dry-run --json --ignore-scripts
```

The parsed output and package-manifest checks were:

```text
REAL NPM 11 PAYLOAD
11.16.0
{
  "payloadShape": "array",
  "packageCount": 1,
  "packageName": "pi-worklist",
  "tarballContains": {
    "dist/cli.js": true,
    "src/extension.ts": true
  },
  "manifest": {
    "bin": {
      "pi-worklist": "dist/cli.js"
    },
    "filesIncludesDist": true
  }
}
NPM 12 OBJECT-SHAPE SHIM PAYLOAD
{
  "payloadShape": "object keyed by package name",
  "topLevelKeys": [
    "pi-worklist"
  ],
  "packageCount": 1,
  "packageName": "pi-worklist",
  "tarballContains": {
    "dist/cli.js": true,
    "src/extension.ts": true
  },
  "manifest": {
    "bin": {
      "pi-worklist": "dist/cli.js"
    },
    "filesIncludesDist": true
  }
}
```

The focused Vitest selector also passed once in each mode:

```text
test/compiled-cli.test.ts > compiled pi-worklist CLI bin > ships the compiled bin in the published package
```
