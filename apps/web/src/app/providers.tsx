"use client";

import type { ReactNode } from "react";
import { SWRConfig } from "swr";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        revalidateOnFocus: true,
        dedupingInterval: 2000,
        errorRetryCount: 3,
      }}
    >
      {children}
    </SWRConfig>
  );
}
