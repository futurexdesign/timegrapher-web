/**
 * Runs the transport contract suite (`tests/contract`) against the simulator.
 *
 * A hardware run would use another harness with the same suite.
 */
import { createSimHarness } from './simHarness';
import { runTransportContract } from './transportContract';

runTransportContract(createSimHarness);
