export interface VsCodeApi<State> {
  postMessage(message: unknown): void;
  getState(): State | undefined;
  setState(state: State): void;
}

declare function acquireVsCodeApi<State>(): VsCodeApi<State>;

/** Typed wrapper; `acquireVsCodeApi` may only be called once per webview. */
export function connect<State, Outgoing>(): {
  post: (message: Outgoing) => void;
  load: () => State | undefined;
  save: (state: State) => void;
} {
  const api = acquireVsCodeApi<State>();
  return {
    post: (message) => api.postMessage(message),
    load: () => api.getState(),
    save: (state) => api.setState(state),
  };
}
