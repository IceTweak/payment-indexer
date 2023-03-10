import { BatchHandlerContext, BatchProcessorItem, EvmBatchProcessor, EvmBlock } from '@subsquid/evm-processor'
import { LogItem } from '@subsquid/evm-processor/lib/interfaces/dataSelection'
import { Store, TypeormDatabase } from '@subsquid/typeorm-store'
import { lookupArchive } from '@subsquid/archive-registry'
import { In } from 'typeorm'
import { Account, Transfer } from './model'

import * as erc20 from './abi/erc20'

const processor = new EvmBatchProcessor()
    .setDataSource({
        archive: lookupArchive('polygon-mumbai'),
    })
    .addLog('0x083c4DD78d68c587C36F01D0f954ee213B2C5B5a', {
        range: {from: 6_082_465},
        filter: [[erc20.events.Transfer.topic]],
        data: {
            evmLog: {
                topics: true,
                data: true,
            },
            transaction: {
                hash: true,
            },
        },
    })

type Item = BatchProcessorItem<typeof processor>
type Ctx = BatchHandlerContext<Store, Item>

processor.run(new TypeormDatabase(), async (ctx) => {
    let transfersData: TransferEventData[] = []

    for (let block of ctx.blocks) {
        for (let item of block.items) {
            if (item.kind !== 'evmLog') continue

            if (item.evmLog.topics[0] === erc20.events.Transfer.topic) {
                transfersData.push(handleTransfer(ctx, block.header, item))
            }
        }
    }

    await saveTransfers(ctx, transfersData)
})

async function saveTransfers(ctx: Ctx, transfersData: TransferEventData[]) {
    let accountIds = new Set<string>()
    for (let t of transfersData) {
        accountIds.add(t.from)
        accountIds.add(t.to)
    }

    let accounts = await ctx.store
        .findBy(Account, {id: In([...accountIds])})
        .then((q) => new Map(q.map((i) => [i.id, i])))

    let transfers: Transfer[] = []

    for (let t of transfersData) {
        let {id, blockNumber, timestamp, txHash, amount} = t

        let from = getAccount(accounts, t.from)
        let to = getAccount(accounts, t.to)

        transfers.push(
            new Transfer({
                id,
                blockNumber,
                timestamp,
                txHash,
                from,
                to,
                amount,
            })
        )
    }

    await ctx.store.save(Array.from(accounts.values()))
    await ctx.store.insert(transfers)
}

interface TransferEventData {
    id: string
    blockNumber: number
    timestamp: Date
    txHash: string
    from: string
    to: string
    amount: bigint
}

function handleTransfer(
    ctx: Ctx,
    block: EvmBlock,
    item: LogItem<{evmLog: {topics: true; data: true}; transaction: {hash: true}}>
): TransferEventData {
    let event = erc20.events.Transfer.decode(item.evmLog)
    return {
        id: item.evmLog.id,
        blockNumber: block.height,
        timestamp: new Date(block.timestamp),
        txHash: item.transaction.hash,
        from: event.from.toLowerCase(),
        to: event.to.toLowerCase(),
        amount: event.value.toBigInt(),
    }
}

function getAccount(m: Map<string, Account>, id: string): Account {
    let acc = m.get(id)
    if (acc == null) {
        acc = new Account()
        acc.id = id
        m.set(id, acc)
    }
    return acc
}
