module.exports = {
  rootDir: '../..', preset: 'ts-jest', testEnvironment: 'node',
  testMatch: ['<rootDir>/test/selfhost/**/*.integration.spec.ts'],
  moduleNameMapper: { '^@shared/(.*)$': '<rootDir>/shared/$1' },
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: { esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true } }] },
  maxWorkers: 1,
};
