export const name = 'test-fixture';
export function apply(ctx) {
  // A deterministic fixture: loading it needs neither an API key nor a model request.
  ctx.on('dispose', () => {});
}
