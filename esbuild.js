const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');

function copyProtos() {
  const src = path.join(__dirname, 'src', 'proto');
  const dest = path.join(__dirname, 'out', 'proto');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

const copyProtoPlugin = {
  name: 'copy-protos',
  setup(build) {
    build.onEnd(() => copyProtos());
  }
};

const ctx = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
  plugins: [copyProtoPlugin]
};

(async () => {
  if (watch) {
    const context = await esbuild.context(ctx);
    await context.watch();
    console.log('esbuild: watching...');
  } else {
    await esbuild.build(ctx);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
