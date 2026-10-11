import { MemoryGatewayStore } from "../src/index.js";
import { storeConformance } from "./store-conformance.js";
storeConformance("memory gateway store", () => Promise.resolve(new MemoryGatewayStore()));
