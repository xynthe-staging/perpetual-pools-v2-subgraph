
import {
	Commit,
	Claim,
	UserAggregateBalance,
	LeveragedPoolByPoolCommitter,
	PendingCommitsByPoolCommitterAndInterval,
	Upkeep,
	LeveragedPool as LeveragedPoolEntity,
} from '../../generated/schema';
import {
	Claim as ClaimEvent,
	CreateCommit,
	ExecutedCommitsForInterval,
	PoolCommitter,
} from '../../generated/templates/PoolCommitter/PoolCommitter';
import { LeveragedPool } from '../../generated/templates/PoolCommitter/LeveragedPool';
import { ERC20 } from '../../generated/templates/PoolCommitter/ERC20';
import { Address, store, BigInt, Bytes } from '@graphprotocol/graph-ts';
import { calcWeightedAverage, floatingPointBytesToInt, initUserAggregateBalance } from '../utils/helper'

let SHORT_MINT = 0;
let SHORT_BURN = 1;
let LONG_MINT = 2;
let LONG_BURN = 3;
let LONG_BURN_SHORT_MINT = 4;
let SHORT_BURN_LONG_MINT = 5;

// event CreateCommit(uint128 indexed commitID, uint256 indexed amount, CommitType indexed commitType);
export function createdCommit(event: CreateCommit): void {
	let id = event.transaction.hash.toHexString()
	let leveragedPoolByPoolCommitter = LeveragedPoolByPoolCommitter.load(event.address.toHexString());

  if(!leveragedPoolByPoolCommitter) {
    throw new Error('LeveragedPoolByPoolCommitter not set when handling new commit')
  }

	let pool = LeveragedPoolEntity.load(leveragedPoolByPoolCommitter.pool.toHexString());

	if(!pool) {
    throw new Error('LeveragedPool not found when handling new commit')
  }

	let commit = new Commit(id);

	let typeRaw = event.params.commitType;
	commit.typeRaw = typeRaw
	commit.amount = event.params.amount;

	if (typeRaw === SHORT_MINT) {
		commit.type = "ShortMint";
	} else if (typeRaw === SHORT_BURN) {
		commit.type = "ShortBurn"
	} else if (typeRaw === LONG_MINT) {
		commit.type = "LongMint"
	} else if (typeRaw === LONG_BURN) {
		commit.type = "LongBurn"
	} else if (typeRaw === LONG_BURN_SHORT_MINT) {
		commit.type = "LongBurnShortMint"
	} else if (typeRaw === SHORT_BURN_LONG_MINT) {
		commit.type = "ShortBurnLongMint"
	}

	if(typeRaw === SHORT_MINT || typeRaw === LONG_MINT) {
		let applicableFee = floatingPointBytesToInt(event.params.mintingFee, new BigInt(0))
		commit.applicableFee = applicableFee
		commit.applicableFeeRaw = event.params.mintingFee
	}

	const trader = event.transaction.from;

	commit.trader = trader;
	commit.txnHash = event.transaction.hash;
	commit.created = event.block.timestamp;
	commit.blockNumber = event.block.number;
	commit.txnHash = event.transaction.hash;
	commit.isExecuted = false;
	commit.updateIntervalId = event.params.appropriateUpdateIntervalId;

	commit.pool = leveragedPoolByPoolCommitter.pool

	commit.save();

	// add to list of known pending commits
	let relevantPendingCommitsId = event.address.toHexString()+'-'+event.params.appropriateUpdateIntervalId.toString();
	let relevantPendingCommits = PendingCommitsByPoolCommitterAndInterval.load(relevantPendingCommitsId);

	if(!relevantPendingCommits) {
		relevantPendingCommits = new PendingCommitsByPoolCommitterAndInterval(relevantPendingCommitsId);
		relevantPendingCommits.commitIds = [];
	}

	// see docs here for updating array values on entities
	// https://thegraph.com/docs/en/developer/assemblyscript-api/
	let commitIds = relevantPendingCommits.commitIds;
	commitIds.push(commit.id);
	relevantPendingCommits.commitIds = commitIds;

	relevantPendingCommits.save();
}

// event ExecutedCommitsForInterval(uint256 indexed updateIntervalId, bytes16 burningFee);
export function executedCommitsForInterval(event: ExecutedCommitsForInterval): void {
	let leveragedPoolByPoolCommitter = LeveragedPoolByPoolCommitter.load(event.address.toHexString());

  if(!leveragedPoolByPoolCommitter) {
    throw new Error('LeveragedPoolByPoolCommitter not set when handling executed commits')
  }

	let poolId = leveragedPoolByPoolCommitter.pool.toHexString()
	const upkeepId = poolId+'-'+event.block.number.toString();

	const poolEntity = LeveragedPoolEntity.load(poolId);

	if(!poolEntity) {
		throw new Error('LeveragedPool entity not set for pool '+poolId+' at commit execution')
	}

	if(!poolEntity.longToken) {
		throw new Error('longToken not set on pool entity '+poolId+' at commit execution')
	}

	if(!poolEntity.shortToken) {
		throw new Error('shortToken not set on pool entity '+poolId+' at commit execution')
	}

	// this will be the first event fired for upkeep on a given pool
	// no need to load an existing upkeep
	const upkeep = new Upkeep(upkeepId);

	upkeep.pool = poolId;
	upkeep.poolAddress = leveragedPoolByPoolCommitter.pool;
	upkeep.txnHash = event.transaction.hash;
	upkeep.timestamp = event.block.timestamp;
	upkeep.blockNumber = event.block.number;
	upkeep.upkeepIntervalId = event.params.updateIntervalId;

	let longTokenAddress = Address.fromString(poolEntity.longToken.toHexString());
	let shortTokenAddress = Address.fromString(poolEntity.shortToken.toHexString());
	let poolAddress = Address.fromString(leveragedPoolByPoolCommitter.pool.toHexString());

	const longTokenInstance = ERC20.bind(longTokenAddress);
	const shortTokenInstance = ERC20.bind(shortTokenAddress);
	const poolCommitterInstance = PoolCommitter.bind(event.address);
	const poolInstance = LeveragedPool.bind(poolAddress);

	const prices = poolCommitterInstance.priceHistory(event.params.updateIntervalId);

	let burningFee = floatingPointBytesToInt(event.params.burningFee, new BigInt(0))
	upkeep.burningFeeRaw = event.params.burningFee;
	upkeep.burningFee = burningFee;

	const longTokenPrice = floatingPointBytesToInt(prices.value0, poolEntity.settlementTokenDecimals);
	const shortTokenPrice = floatingPointBytesToInt(prices.value1, poolEntity.settlementTokenDecimals);
	upkeep.longTokenPrice = longTokenPrice;
	upkeep.longTokenPriceRaw = prices.value0;
	upkeep.shortTokenPrice = shortTokenPrice;
	upkeep.shortTokenPriceRaw = prices.value1;

	const balances = poolInstance.balances();

	upkeep.shortBalance = balances.value0;
	upkeep.longBalance = balances.value1;
	upkeep.longTokenSupply = longTokenInstance.totalSupply();
	upkeep.shortTokenSupply = shortTokenInstance.totalSupply();

	upkeep.save();

	// add to list of known pending commits
	let relevantPendingCommitsId = event.address.toHexString()+'-'+event.params.updateIntervalId.toString();
	let relevantPendingCommits = PendingCommitsByPoolCommitterAndInterval.load(relevantPendingCommitsId);

	// if there is no entry, it means that no commits were executed in this interval
	if(relevantPendingCommits) {
		const traders: Array<Bytes> = [];

		for(let i = 0; i < relevantPendingCommits.commitIds.length; ++i) {
			let commitId = relevantPendingCommits.commitIds[i];
			let commit = Commit.load(commitId);

			if(!commit) {
				throw new Error('Commit entity not found for pending commit id '+commitId);
			}

			commit.upkeep = upkeepId
			commit.isExecuted = true;
			const typeRaw = commit.typeRaw;
			// if the commit type is not a mint type
			// the applicable fee is the burn fee
			if (typeRaw !== SHORT_MINT && typeRaw !== LONG_MINT) {
				commit.applicableFee = burningFee;
				commit.applicableFeeRaw = event.params.burningFee
			}
			commit.save();

			if (!traders.includes(commit.trader)) {
				traders.push(commit.trader)
			}
		}

		for (let i = 0; i < traders.length; i++) {
			let trader = traders[i]

			const aggregateBalanceId = poolId+'-'+trader.toHexString();
			let aggregateBalancesEntity = UserAggregateBalance.load(aggregateBalanceId);

			if (!aggregateBalancesEntity) {
				aggregateBalancesEntity = initUserAggregateBalance(poolId, trader)
			}
			const traderAddress = Address.fromString(trader.toHexString());
			// TODO this can be back calculated commit amount and price
			// would need to summate token amounts
			// burnTokenDiff = commitAmount / price
			// mintTokenDiff = commitAmount * price
			const aggregateBalances = poolCommitterInstance.getAggregateBalance(traderAddress);

			let shortTokenDiff = aggregateBalancesEntity.shortTokenHolding.minus(aggregateBalances.shortTokens);
			let longTokenDiff = aggregateBalancesEntity.longTokenHolding.minus(aggregateBalances.longTokens);

			const ZERO = BigInt.fromI32(0);

			if (aggregateBalances.shortTokens.equals(ZERO)) { // no more tokens
				aggregateBalancesEntity.shortTokenAvgBuyIn = BigInt.fromI32(0)
			} else if (shortTokenDiff.lt(ZERO)) {
				// user has minted more tokens balance has increased
				shortTokenDiff = shortTokenDiff.abs()
				aggregateBalancesEntity.shortTokenAvgBuyIn = calcWeightedAverage(
					[aggregateBalancesEntity.shortTokenHolding, shortTokenDiff],
					[aggregateBalancesEntity.shortTokenAvgBuyIn, shortTokenPrice],
				)
			}
			// if the user has burnt some amount but not all the token diff will be > 0
			// and will fall through these checks

			if (aggregateBalances.longTokens.equals(ZERO)) { // no more tokens
				aggregateBalancesEntity.longTokenAvgBuyIn = BigInt.fromI32(0)
			} else if (longTokenDiff.lt(ZERO)) {
				// user has minted more tokens balance has increased
				longTokenDiff = longTokenDiff.abs();
				aggregateBalancesEntity.longTokenAvgBuyIn = calcWeightedAverage(
					[aggregateBalancesEntity.longTokenHolding, longTokenDiff],
					[aggregateBalancesEntity.longTokenAvgBuyIn, longTokenPrice],
				)
			}

			aggregateBalancesEntity.longTokenHolding = aggregateBalances.longTokens;
			aggregateBalancesEntity.shortTokenHolding = aggregateBalances.shortTokens;
			aggregateBalancesEntity.settlementTokenHolding = aggregateBalances.settlementTokens;

			aggregateBalancesEntity.save();
		}


		// remove the pending commits from the store
		store.remove('PendingCommitsByPoolCommitterAndInterval', relevantPendingCommitsId)
	}
}

export function claim(event: ClaimEvent): void {
	let leveragedPoolByPoolCommitter = LeveragedPoolByPoolCommitter.load(event.address.toHexString());
	if(!leveragedPoolByPoolCommitter) {
		throw new Error('LeveragedPoolByPoolCommitter not set when handling claim')
	}

	let pool = LeveragedPoolEntity.load(leveragedPoolByPoolCommitter.pool.toHexString());

	if(!pool) {
		throw new Error('LeveragedPool not found when handling claim')
	}

	const aggregateBalanceId = pool.id.toString()+'-'+event.params.user.toHexString();
	let aggregateBalance = UserAggregateBalance.load(aggregateBalanceId);

	if (!aggregateBalance) {
		aggregateBalance = initUserAggregateBalance(pool.id, event.params.user);
	}

	aggregateBalance.longTokenHolding = BigInt.fromI32(0);
	aggregateBalance.shortTokenHolding = BigInt.fromI32(0);
	aggregateBalance.settlementTokenHolding = BigInt.fromI32(0);


	aggregateBalance.save();

	// store claim event
	const claim = new Claim(event.transaction.hash.toHexString());

	claim.blockNumber = event.block.number;
	claim.timestamp = event.block.timestamp;
	claim.trader = event.params.user;
	claim.pool = pool.id;
	claim.poolAddress = pool.id;

	claim.save();
}