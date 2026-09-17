export async function readMotionSample(accelerometer, { timeoutMs = 2_000, intervalMs = 250 } = {}) {
  const available = await accelerometer.isAvailableAsync();
  if (!available) throw new Error('Motion sensor is unavailable on this device.');

  const permission = await accelerometer.requestPermissionsAsync();
  if (permission.status !== 'granted') throw new Error('Motion permission was not granted.');

  accelerometer.setUpdateInterval(intervalMs);
  return new Promise((resolve, reject) => {
    let subscription;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      subscription?.remove();
      callback(value);
    };
    const timeout = setTimeout(() => finish(reject, new Error('Motion sensor did not respond.')), timeoutMs);
    try {
      subscription = accelerometer.addListener((reading) => {
        const magnitude = Math.sqrt((Number(reading.x) || 0) ** 2 + (Number(reading.y) || 0) ** 2 + (Number(reading.z) || 0) ** 2);
        const deviation = Math.abs(magnitude - 1);
        finish(resolve, { active: deviation > 0.12, activity: 'unknown', confidence: Math.max(0, Math.min(1, 1 - deviation)) });
      });
      if (settled) subscription.remove();
    } catch (error) {
      finish(reject, error);
    }
  });
}
