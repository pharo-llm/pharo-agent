# Pharo Integration

Configure the VM and image:

```sh
pharo-agent configure --pharo-vm /path/to/pharo --image /path/to/Pharo.image
pharo-agent doctor
```

Environment variables are also supported:

```sh
export PHARO_VM=/path/to/pharo
export PHARO_IMAGE=/path/to/Pharo.image
```

## Commands

Inspect the image:

```sh
pharo-agent inspect
pharo-agent inspect MyClass
```

Evaluate Smalltalk:

```sh
pharo-agent eval "Stdio stdout nextPutAll: (1 + 1) asString; cr"
```

Run a script:

```sh
pharo-agent st examples/run-sunit.st
```

Run tests:

```sh
pharo-agent test
pharo-agent test --package MyPackage
pharo-agent test --class MyTestCase
pharo-agent test --class MyTestCase --selector testSomething
```

## E2E Tests

The repository includes optional E2E tests. They run only when the required environment variables exist:

```sh
PHARO_VM=/path/to/pharo PHARO_IMAGE=/path/to/Pharo.image npm run test:e2e
PHARO_AGENT_E2E_BASE_URL=http://127.0.0.1:8080/v1 npm run test:e2e
```

Full SUnit E2E is opt-in because some images contain very large test suites:

```sh
PHARO_VM=/path/to/pharo \
PHARO_IMAGE=/path/to/Pharo.image \
PHARO_AGENT_E2E_RUN_SUNIT=1 \
PHARO_AGENT_E2E_TEST_CLASS=MyTestCase \
npm run test:e2e
```
