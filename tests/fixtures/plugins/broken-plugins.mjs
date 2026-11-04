// Fixture: named exports of broken plugins (tests pick one with `#name` via small wrapper files).
export const wrongApi = { name: "wrong-api", apiVersion: 2, setup() {} };
export const throwsInSetup = {
  name: "throws-in-setup",
  apiVersion: 1,
  setup() {
    throw new Error("boom in setup");
  },
};
export const usesExecutor = {
  name: "uses-executor",
  apiVersion: 1,
  setup(api) {
    api.registerExecutor("grpc", {});
  },
};
