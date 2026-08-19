export const BROWSER_RESULT_COUNT = 51;

const browsers = ['chromium', 'firefox', 'webkit'];
const viewports = [320, 768, 1024, 1440];
const viewportModes = ['default', 'zoom-200', 'reduced-motion', 'forced-colors'];

const key = ({ browser, width, mode }) => `${browser}/${String(width)}/${mode}`;

export const expectedBrowserResults = () =>
  browsers.flatMap((browser) => [
    ...viewports.flatMap((width) => viewportModes.map((mode) => ({ browser, width, mode }))),
    { browser, width: 768, mode: 'native-flows' }
  ]);

export const browserMatrixIssues = (results) => {
  if (!Array.isArray(results)) return ['browser results are not an array'];
  const expected = new Set(expectedBrowserResults().map(key));
  const observed = new Map();
  const issues = [];

  if (results.length !== BROWSER_RESULT_COUNT)
    issues.push(
      `expected ${String(BROWSER_RESULT_COUNT)} results, received ${String(results.length)}`
    );

  for (const result of results) {
    const resultKey =
      result !== null && typeof result === 'object'
        ? key({ browser: result.browser, width: result.width, mode: result.mode })
        : '(invalid)';
    observed.set(resultKey, (observed.get(resultKey) ?? 0) + 1);
    if (!expected.has(resultKey)) issues.push(`unexpected result ${resultKey}`);
  }

  for (const [resultKey, count] of observed)
    if (count > 1) issues.push(`duplicate result ${resultKey}`);
  for (const resultKey of expected)
    if (!observed.has(resultKey)) issues.push(`missing result ${resultKey}`);

  return issues;
};
