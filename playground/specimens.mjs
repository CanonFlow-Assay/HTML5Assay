export const specimens = [
  {
    id: 'minimal-pass',
    name: 'Minimal native document',
    purpose: 'Shows the source-preview subset clear on a local, native-first document.',
    policy: 'cff-web-strict',
    expectedVerdict: 'Inconclusive',
    expectedFindingIds: [],
    digest: '2536257514e6c04d7bb02126264ca8e4499d9ed570aacda5884bf355b923a838',
    input: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Local evidence example</title>
</head>
<body>
  <a href="#main">Skip to primary content</a>
  <header><nav aria-label="Primary"><a href="./index.html">Overview</a></nav></header>
  <main id="main"><h1>Local evidence example</h1><p>Core content is available without scripts.</p></main>
  <footer><p>Static evidence preview.</p></footer>
</body>
</html>
`
  },
  {
    id: 'unsafe-runtime',
    name: 'Remote and scripted behavior',
    purpose: 'Shows strict-policy failures for a remote dependency and an inline event handler.',
    policy: 'cff-web-strict',
    expectedVerdict: 'Fail',
    expectedFindingIds: ['H5A-SAFE-001', 'H5A-SAFE-002'],
    digest: 'ced8ac4b1e9acea2ed55792fc454c71f971c721a5c40a6802a5c20236666ae57',
    input: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Unsafe runtime example</title>
</head>
<body>
  <a href="#main">Skip to primary content</a>
  <header><nav aria-label="Primary"><a href="./index.html">Overview</a></nav></header>
  <main id="main">
    <h1>Unsafe runtime example</h1>
    <button type="button" onclick="runRemoteTask()">Run task</button>
    <img src="https://example.invalid/status.svg" alt="Current service status">
  </main>
  <footer><p>Static evidence preview.</p></footer>
</body>
</html>
`
  }
];
