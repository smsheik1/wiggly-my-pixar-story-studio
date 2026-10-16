export default {
  name: 'noop',
  run: async ({ outputs, inputs, runDir }) => ({
    score: null,
    details: 'stub',
  }),
};
