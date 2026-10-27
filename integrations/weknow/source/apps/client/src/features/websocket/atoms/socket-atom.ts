import { atom, type PrimitiveAtom } from "jotai";
import { Socket } from "socket.io-client";

export const socketAtom: PrimitiveAtom<Socket | null> = atom(
  null as Socket | null,
);
