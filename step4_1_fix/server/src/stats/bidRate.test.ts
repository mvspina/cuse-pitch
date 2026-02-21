/**
 * Assert: bidRate = bidsMade / bidsAttempted, clamped to [0, 1]; never exceeds 100%.
 * Run with: npx tsx src/stats/bidRate.test.ts
 */
import { computeBidRate } from './store'

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

// computeBidRate(bidsAttempted, bidsMade)
assert(computeBidRate(0, 0) === 0, '0,0 -> 0')
assert(computeBidRate(1, 1) === 1, '1,1 -> 1')
assert(computeBidRate(1, 0) === 0, '1,0 -> 0')
assert(computeBidRate(2, 1) === 0.5, '2,1 -> 0.5')
assert(computeBidRate(1, 2) === 1, '1,2 -> clamped to 1')
assert(computeBidRate(10, 15) === 1, '10,15 -> clamped to 1')
assert(computeBidRate(100, 50) === 0.5, '100,50 -> 0.5')
assert(!Number.isNaN(computeBidRate(0, 0)), 'no NaN for 0,0')
assert(computeBidRate(1, 1) <= 1, 'invariant: bidRate <= 1')
assert(computeBidRate(1, 2) <= 1, 'invariant: bidRate <= 1 when bidsMade > bidsAttempted')
assert(computeBidRate(5, 3) <= 1, 'invariant: bidRate <= 1 when bidsAttempted >= bidsMade')

console.log('bidRate tests passed: bidRate never exceeds 1.0')
