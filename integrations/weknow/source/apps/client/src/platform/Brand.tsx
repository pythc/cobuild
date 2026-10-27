import React from "react";
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <img
      src="/weknow-mark.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      style={{ display: "block", objectFit: "contain", flexShrink: 0 }}
    />
  );
}
