module.exports = ({ config }) => {
  const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID || process.env.EAS_PROJECT_ID || config.extra?.eas?.projectId;
  return projectId
    ? { ...config, extra: { ...config.extra, eas: { ...config.extra?.eas, projectId } } }
    : config;
};
