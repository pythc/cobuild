import { useEffect } from 'react';
import { relayWidgetGrant } from '@/api';
import { mountRelayWidget } from './relay-widget';
export default function RelayWidget() {
  useEffect(() => {
    const widget = mountRelayWidget({
      app: 'makit',
      grant: async (challenge: string) => {
        return relayWidgetGrant(challenge);
      },
    });
    return () => widget.destroy();
  }, []);
  return null;
}
