import { prisma } from '@/lib/db';
import { sendAPNSNotification, isAPNSConfigured } from '@/lib/apns';

type PushBroadcastInput = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

async function deactivateDeviceToken(token: string) {
  await prisma.pushDevice.updateMany({
    where: { token },
    data: { isActive: false },
  }).catch(() => undefined);
}

export async function notifyAllActiveDevices(input: PushBroadcastInput) {
  if (!isAPNSConfigured()) {
    return { sent: 0, skipped: true as const };
  }

  const devices = await prisma.pushDevice.findMany({
    where: {
      isActive: true,
      platform: 'ios',
      user: {
        isActive: true,
      },
    },
    select: {
      token: true,
      environment: true,
    },
  });

  let sent = 0;

  for (const device of devices) {
    try {
      await sendAPNSNotification({
        deviceToken: device.token,
        title: input.title,
        body: input.body,
        data: input.data,
        environment: device.environment === 'sandbox' ? 'sandbox' : 'production',
      });
      sent += 1;
    } catch (error: any) {
      const reason = String(error?.message || '');
      if (reason.includes('BadDeviceToken') || reason.includes('Unregistered') || reason.includes('DeviceTokenNotForTopic')) {
        await deactivateDeviceToken(device.token);
      }
    }
  }

  return { sent, skipped: false as const };
}
