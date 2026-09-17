export function expoProjectId(constants = {}) {
  return constants.expoConfig?.extra?.eas?.projectId || constants.easConfig?.projectId || null;
}
