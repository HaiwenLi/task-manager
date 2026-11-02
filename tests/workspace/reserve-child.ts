import { reserveWorkspace } from "../../src/workspace.js";

// Intentionally exit without releasing: the parent's test also verifies that
// process death alone never authorizes workspace-lock theft.
const reservation = await reserveWorkspace(process.argv[2]!, process.argv[3]!, process.argv[4]);
console.log(reservation ? "won" : "busy");
