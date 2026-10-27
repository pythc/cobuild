export function mountRelayWidget(options: {
  app: string;
  grant: (challenge: string) => Promise<{ grant: string }>;
}): { destroy: () => void };
