import typescript from '@rollup/plugin-typescript';

const workerPlugin = () => ({
  name: 'inline-worker',
  transform(code, id) {
    if (!id.endsWith('demux-worker.ts')) return null;
    return null;
  },
});

export default [
  {
    input: 'src/index.ts',
    output: [
      {
        file: 'dist/jsmxf.esm.js',
        format: 'esm',
        sourcemap: true,
      },
      {
        file: 'dist/jsmxf.js',
        format: 'umd',
        name: 'Jsmxf',
        sourcemap: true,
      },
    ],
    plugins: [
      typescript({ tsconfig: './tsconfig.json' }),
    ],
  },
];
