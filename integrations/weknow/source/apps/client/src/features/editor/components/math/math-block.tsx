import type { NodeViewProps } from "@tiptap/react";
import { MathView } from "./math-view";
export default function MathBlockView(props: NodeViewProps) {
  return <MathView {...props} />;
}
