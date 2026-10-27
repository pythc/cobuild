import { useEffect } from 'react';
import { relayWidgetGrant } from '@/api';
import { mountRelayWidget } from './relay-widget';
import {suiteRuntime} from '@/lib/suite-runtime';
export default function RelayWidget() {
  useEffect(() => {
    if(suiteRuntime()?.relay===false)return;
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
