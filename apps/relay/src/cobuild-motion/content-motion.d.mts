export interface ContentMotion {
  enter(element: Element | null, key: string): void;
  cancel(): void;
  dispose(): void;
}
export function createContentMotion(view?: Window): ContentMotion;
