import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { createContentMotion } from "./content-motion.mjs";

export function useContentMotion() {
  const { pathname } = useLocation();
  useEffect(() => {
    const motion = createContentMotion();
    motion.enter(document.querySelector(".mantine-AppShell-main"), pathname);
    return () => motion.dispose();
  }, [pathname]);
}
