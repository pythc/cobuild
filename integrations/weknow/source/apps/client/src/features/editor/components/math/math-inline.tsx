import type { NodeViewProps } from "@tiptap/react";
import { MathView } from "./math-view";
export default function MathInlineView(props: NodeViewProps) {
  return <MathView {...props} inline />;
}
