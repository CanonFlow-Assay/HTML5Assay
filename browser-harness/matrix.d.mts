export interface BrowserMatrixResult {
  readonly browser: string;
  readonly width: number;
  readonly mode: string;
}

export declare const BROWSER_RESULT_COUNT: 51;
export declare const expectedBrowserResults: () => ReadonlyArray<BrowserMatrixResult>;
export declare const browserMatrixIssues: (results: unknown) => ReadonlyArray<string>;
