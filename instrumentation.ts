export function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.info('[node-runtime] ' + process.version);
  }
}
