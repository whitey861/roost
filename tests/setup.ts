// Vitest global setup. Runs once before any test file.
//
// Belt-and-braces guard against tests accidentally calling the real
// Voyage embedding API: even if the developer has VOYAGE_API_KEY set
// locally, tests should never spend money or hit the network.
// Tests that explicitly want retrieval (chat-knowledge.test.ts) set
// the variable inside a `withVoyageStub` helper before each case.

delete process.env.VOYAGE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
