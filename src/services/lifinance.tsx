import { NxtpSdk, NxtpSdkEvents } from '@connext/nxtp-sdk'
import { encodeAuctionBid } from '@connext/nxtp-sdk/dist/utils'
import { AuctionResponse, getRandomBytes32 } from '@connext/nxtp-utils'
import { JsonRpcSigner } from '@ethersproject/providers'
import BigNumber from 'bignumber.js'
import { constants, ethers } from 'ethers'
import { getRpcProviders } from '../components/web3/connectors'
import { ChainId, CrossAction, CrossEstimate, CrossStep, Execution, getChainById, LiFiStep, Step, SwapAction, SwapEstimate, SwapStep } from '../types'
import { oneInch } from './1Inch'
import abi from './ABI/dimond.json'
import { checkAllowance } from './allowance.execute'
import * as nxtp from './nxtp'
import { paraswap } from './paraswap'
import { createAndPushProcess, initStatus, setStatusDone, setStatusFailed } from './status'
import * as uniswap from './uniswaps'

const USE_CONTRACT_FOR_WITHDRAW = false
const lifiContractAddress = '0xa74D44ed9C3BB96d7676E7A274c33A05210cf35a'

const getSupportedChains = (jsonArraySting: string): ChainId[] => {
  try {
    const chainIds = JSON.parse(jsonArraySting)
    return chainIds
  } catch (e) {
    return []
  }
}

const supportedChains = [ChainId.RIN, ChainId.GOR, ChainId.POL, ChainId.DAI, ChainId.BSC, ChainId.FTM] || getSupportedChains(process.env.REACT_APP_LIFI_CONTRACT_ENABLED_CHAINS_JSON!)

const buildSwap = async (swapAction: SwapAction, swapEstimate: SwapEstimate, srcAddress: string, destAddress: string) => {
  switch (swapAction.tool) {
    case 'paraswap': {
      const call = await paraswap.getSwapCall(swapAction, swapEstimate, srcAddress, destAddress)
      return {
        approveTo: await paraswap.getContractAddress(swapAction.chainId),
        call,
      }
    }
    case '1inch': {
      const call = await oneInch.getSwapCall(swapAction, swapEstimate, srcAddress, destAddress)
      return {
        approveTo: call.to,
        call,
      }
    }

    default: {
      const call = await uniswap.getSwapCall(swapAction, swapEstimate, srcAddress, destAddress)
      return {
        approveTo: call.to,
        call,
      }
    }
  }
}

const getQuote = async (signer: JsonRpcSigner, nxtpSDK: NxtpSdk, crossStep: CrossStep, crossAction: CrossAction, receiverTransaction?: ethers.PopulatedTransaction) => {
  // -> request quote
  let quote: AuctionResponse | undefined
  try {
    quote = await nxtp.getTransferQuote(nxtpSDK, crossAction.chainId, crossAction.token.id, crossAction.toChainId, crossAction.toToken.id, crossAction.amount.toString(), await signer.getAddress(), receiverTransaction?.to, receiverTransaction?.data, lifiContractAddress)
    if (!quote) throw Error("Quote confirmation failed!")
  } catch (e: any) {
    cleanUp(nxtpSDK)
    throw e
  }

  // -> store quote
  const crossEstimate: CrossEstimate = {
    type: 'cross',
    fromAmount: quote.bid.amount,
    toAmount: quote.bid.amountReceived,
    fees: {
      included: true,
      percentage: '0.0005',
      token: crossAction.token,
      amount: new BigNumber(quote.bid.amount).times('0.0005').toString(),
    },
    data: quote,
  }
  crossStep.estimate = crossEstimate

  return quote
}

const buildTransaction = async (signer: JsonRpcSigner, nxtpSDK: NxtpSdk, startSwapStep: SwapStep | undefined, crossStep: CrossStep, endSwapStep: SwapStep | undefined) => {
  const lifi = new ethers.Contract(lifiContractAddress, abi, signer)

  interface LifiData {
    transactionId: string
    integrator: string
    referrer: string
    sendingAssetId: string
    receivingAssetId: string
    receiver: string
    destinationChainId: string
    amount: string
  }

  const lifiData: LifiData = {
    transactionId: getRandomBytes32(),
    integrator: 'li.finance',
    referrer: '0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0',
    sendingAssetId: crossStep.action.token.id,
    receivingAssetId: crossStep.action.toToken.id,
    receiver: await signer.getAddress(),
    destinationChainId: crossStep.action.toChainId.toString(),
    amount: crossStep.action.amount,
  }

  // Receiving side
  let receivingTransaction
  if (endSwapStep) {
    const swapAction = endSwapStep.action
    const swapEstimate = endSwapStep.estimate as SwapEstimate

    // adjust lifData
    lifiData.receivingAssetId = swapAction.toToken.id

    if (supportedChains.includes(endSwapStep.action.chainId)) {
      // Swap and Withdraw via LiFi Contract
      const swapCall = await buildSwap(swapAction, swapEstimate, lifiContractAddress, lifiContractAddress)

      receivingTransaction = await lifi.populateTransaction.swapAndCompleteBridgeTokensViaNXTP(
        lifiData,
        [
          {
            sendingAssetId: swapAction.token.id,
            receivingAssetId: swapAction.toToken.id,
            fromAmount: swapEstimate.fromAmount,
            callTo: swapCall.call.to,
            callData: swapCall.call.data,
            approveTo: swapCall.approveTo,
          },
        ],
        swapAction.toToken.id,
        await signer.getAddress()
      )
    } else {
      // Swap on DEX directly
      const swapCall = await buildSwap(swapAction, swapEstimate, await signer.getAddress(), await signer.getAddress())
      receivingTransaction = swapCall.call
    }
  } else if (USE_CONTRACT_FOR_WITHDRAW) {
    // Withdraw only
    receivingTransaction = await lifi.populateTransaction.completeBridgeTokensViaNXTP(
      lifiData,
      crossStep.action.toToken.id,
      await signer.getAddress(),
      crossStep.estimate.data.bid.amountReceived
    )
  }

  await getQuote(signer, nxtpSDK, crossStep, crossStep.action, receivingTransaction)

  // Sending side
  const expiry = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 3
  const nxtpData = {
    invariantData: {
      ...crossStep.estimate.data.bid,
      sendingChainFallback: await signer.getAddress(),
    },
    amount: crossStep.estimate.data.bid.amount,
    expiry: expiry,
    encodedBid: encodeAuctionBid(crossStep.estimate.data.bid),
    bidSignature: crossStep.estimate.data.bidSignature || '',
    encodedMeta: '0x',
    encryptedCallData: crossStep.estimate.data.bid.encryptedCallData,
    callDataHash: crossStep.estimate.data.bid.callDataHash,
    callTo: crossStep.estimate.data.bid.callTo,
  }
  const swapOptions: any = {
    gasLimit: 900000,
  }

  if (startSwapStep) {
    // Swap and Transfer
    const swapAction = startSwapStep.action as SwapAction
    const swapEstimate = startSwapStep.estimate as SwapEstimate

    // adjust lifData
    lifiData.sendingAssetId = swapAction.token.id
    lifiData.amount = swapAction.amount

    // > build swap
    const swapCall = await buildSwap(swapAction, swapEstimate, lifiContractAddress, lifiContractAddress)

    const swapData = {
      sendingAssetId: swapAction.token.id,
      receivingAssetId: swapAction.toToken.id,
      fromAmount: swapEstimate.fromAmount,
      callTo: swapCall.call.to,
      callData: swapCall?.call.data,
      approveTo: swapCall.approveTo,
    }

    // > pass native currency directly
    if (swapAction.token.id === constants.AddressZero) {
      swapOptions.value = swapEstimate.fromAmount
    }

    // Debug log
    console.debug({
      method: 'swapAndStartBridgeTokensViaNXTP',
      lifiData,
      nxtpData,
      swapData,
      swapOptions,
    })

    // > swap and transfer
    return lifi.populateTransaction.swapAndStartBridgeTokensViaNXTP(
      lifiData,
      [swapData],
      nxtpData,
      swapOptions
    )
  } else {
    // Transfer only
    // > pass native currency directly
    if (crossStep.action.token.id === constants.AddressZero) {
      swapOptions.value = crossStep.estimate.fromAmount
    }

    // Debug log
    console.debug({
      method: 'startBridgeTokensViaNXTP',
      lifiData,
      nxtpData,
      swapOptions,
    })

    // > transfer only
    return lifi.populateTransaction.startBridgeTokensViaNXTP(
      lifiData,
      nxtpData,
      swapOptions,
    )
  }
}

const executeLifi = async (signer: JsonRpcSigner, step: LiFiStep, updateStatus?: Function, initialStatus?: Execution) => {
  const route = step.includedSteps

  // unpack route
  const startSwapStep = route[0].action.type === 'swap' ? route[0] as SwapStep : undefined
  const endSwapStep = route[route.length - 1].action.type === 'swap' ? route[route.length - 1] as SwapStep : undefined
  const crossStep = route.find(step => step.action.type === 'cross')! as CrossStep
  const crossAction = crossStep.action as CrossAction
  const fromChain = getChainById(crossAction.chainId)
  const toChain = getChainById(crossAction.toChainId)

  // setup
  let { status, update } = initStatus(updateStatus, initialStatus)

  // ## DEACTIVATED, because key is requested in sdk
  // // Request public key
  // // -> set status
  // const keyProcess = createAndPushProcess(update, status, 'Provide Public Key', { status: 'ACTION_REQUIRED' })
  // // -> request key
  // let encryptionPublicKey
  // try {
  //   encryptionPublicKey = await (window as any).ethereum.request({
  //     method: "eth_getEncryptionPublicKey",
  //     params: [await signer.getAddress()], // you must have access to the specified account
  //   })
  // } catch (e) {
  //   console.error(e)
  //   setStatusFailed(update, status, keyProcess)
  //   throw e
  // }
  // // -> set status
  // setStatusDone(update, status, keyProcess)


  // Allowance
  if (route[0].action.token.id !== constants.AddressZero) {
    await checkAllowance(signer, fromChain, route[0].action.token, route[0].action.amount, lifiContractAddress, update, status, true) // route[0].action.amount
  }

  // Transaction
  // -> set status
  const submitProcess = createAndPushProcess(update, status, 'Preparing Transaction', { status: 'PENDING' })

  // -> prepare
  let call
  let nxtpSDK
  try {
    const crossableChains = [crossAction.chainId, crossAction.toChainId]
    const chainProviders = getRpcProviders(crossableChains)
    nxtpSDK = await nxtp.setup(signer, chainProviders)
    call = await buildTransaction(signer, nxtpSDK, startSwapStep, crossStep, endSwapStep)
  } catch (e: any) {
    if (e.message) submitProcess.errorMessage = e.message
    if (e.code) submitProcess.errorCode = e.code
    setStatusFailed(update, status, submitProcess)
    if (nxtpSDK) cleanUp(nxtpSDK)
    throw e
  }

  // -> set status
  submitProcess.message = 'Send Transaction'
  submitProcess.status = 'ACTION_REQUIRED'
  update(status)

  // -> send
  let tx
  try {
    tx = await signer.sendTransaction(call)
  } catch (e: any) {
    if (e.message) submitProcess.errorMessage = e.message
    if (e.code) submitProcess.errorCode = e.code
    setStatusFailed(update, status, submitProcess)
    throw e
  }

  // -> set status
  submitProcess.status = 'PENDING'
  submitProcess.txHash = tx.hash
  submitProcess.txLink = fromChain.metamask.blockExplorerUrls[0] + 'tx/' + submitProcess.txHash
  submitProcess.message = <>Send Transaction - Wait for <a href={submitProcess.txLink} target="_blank" rel="nofollow noreferrer">Tx</a></>
  update(status)

  // -> wait
  try {
    await tx.wait()
  } catch (e: any) {
    if (e.message) submitProcess.errorMessage = e.message
    if (e.code) submitProcess.errorCode = e.code
    setStatusFailed(update, status, submitProcess)
    cleanUp(nxtpSDK)
    throw e
  }

  // -> set status
  submitProcess.message = <>Transaction Sent: <a href={submitProcess.txLink} target="_blank" rel="nofollow noreferrer">Tx</a></>
  setStatusDone(update, status, submitProcess)


  // Wait for receiver
  // -> set status
  const receiverProcess = createAndPushProcess(update, status, 'Wait for Receiver', { type: 'wait' })

  // -> wait
  let prepared
  try {
    prepared = await nxtpSDK.waitFor(
      NxtpSdkEvents.ReceiverTransactionPrepared,
      600_000, // 10 min
      (data) => data.txData.transactionId === crossStep.estimate.data.bid.transactionId // filter function
    )
  } catch (e) {
    receiverProcess.errorMessage = 'Failed to get an answer in time. Please go to https://xpollinate.io/ and check the state of your transaction there.'
    setStatusFailed(update, status, receiverProcess)
    cleanUp(nxtpSDK)
    throw e
  }

  // -> set status
  receiverProcess.txHash = prepared.transactionHash
  receiverProcess.txLink = toChain.metamask.blockExplorerUrls[0] + 'tx/' + receiverProcess.txHash
  receiverProcess.message = <>Receiver Prepared: <a href={receiverProcess.txLink} target="_blank" rel="nofollow noreferrer">Tx</a></>
  setStatusDone(update, status, receiverProcess)


  // Sign to claim
  // -> set status
  const proceedProcess = createAndPushProcess(update, status, 'Ready to be Signed', { type: 'claim', status: 'ACTION_REQUIRED' })

  // Signed Event
  nxtpSDK.attach(NxtpSdkEvents.ReceiverPrepareSigned, (data) => {
    if (data.transactionId !== crossStep.estimate.data.bid.transactionId) return
    if (proceedProcess) {
      proceedProcess.status = 'PENDING'
      proceedProcess.message = 'Signed - Wait for Claim'
      update(status)
    }
  })

  // -> sign
  try {
    nxtp.finishTransfer(nxtpSDK, prepared, crossStep, update)
  } catch (e) {
    proceedProcess.errorMessage = 'Failed to get an answer in time. Please go to https://xpollinate.io/ and check the state of your transaction there.'
    setStatusFailed(update, status, proceedProcess)
    cleanUp(nxtpSDK)
    throw e
  }

  // -> wait
  let claimed
  try {
    claimed = await nxtpSDK.waitFor(
      NxtpSdkEvents.ReceiverTransactionFulfilled,
      200_000,
      (data) => data.txData.transactionId === crossStep.estimate.data.bid.transactionId // filter function
    )
  } catch (e) {
    proceedProcess.errorMessage = 'Failed to get an answer in time. Please go to https://xpollinate.io/ and check the state of your transaction there.'
    setStatusFailed(update, status, proceedProcess)
    cleanUp(nxtpSDK)
    throw e
  }

  // -> set status
  proceedProcess.txHash = claimed.transactionHash
  proceedProcess.txLink = toChain.metamask.blockExplorerUrls[0] + 'tx/' + proceedProcess.txHash
  proceedProcess.message = <>Funds Claimed: <a href={proceedProcess.txLink} target="_blank" rel="nofollow noreferrer">Tx</a></>
  setStatusDone(update, status, proceedProcess)

  // DONE
  // TODO: get and parse claim transacation receipt
  status.status = 'DONE'
  update(status)
  return status
}

const cleanUp = (sdk: NxtpSdk) => {
  sdk.removeAllListeners()
}

const parseRoutes = (routes: Step[][], allowLiFi: boolean = true) => {
  if (!allowLiFi) {
    return routes
  }

  return routes.map(route => {
    const firstStep = route[0]
    const lastStep = route[route.length - 1]
    const crossStep = route.find(step => step.action.type === 'cross')
    if (!crossStep) return route // perform simple swaps directly

    const crossAction = crossStep.action as CrossAction
    if (crossAction.tool !== 'nxtp') return route // only reroute nxtp transfers
    if (!supportedChains.includes(crossAction.chainId)) return route // only where contract is deployed

    // paraswap can't be called on receiving chain without our contract depoyed there
    if (lastStep.action.type === 'swap' && lastStep.action.tool === 'paraswap' && !supportedChains.includes(lastStep.action.chainId)) {
      // parse route
      const lifiStep: LiFiStep = {
        action: {
          type: 'lifi',
          chainId: firstStep.action.chainId,
          amount: firstStep.action.amount,
          token: firstStep.action.token,
          address: firstStep.action.address,
          toChainId: crossAction.toChainId,
          toToken: crossStep.action.toToken,
          toAddress: crossStep.action.toAddress,
          slippage: 3.0,
        },
        estimate: {
          type: 'lifi',
          fromAmount: firstStep.estimate.fromAmount,
          toAmount: crossStep.estimate.toAmount,
          toAmountMin: crossStep.estimate.toAmount,
          feeCosts: [],
          gasCosts: [],
        },
        includedSteps: route.slice(0, -1)
      }

      return [lifiStep, lastStep]
    }

    // parse route
    const lifiStep: LiFiStep = {
      action: {
        type: 'lifi',
        chainId: firstStep.action.chainId,
        amount: firstStep.action.amount,
        token: firstStep.action.token,
        address: firstStep.action.address,
        toChainId: crossAction.toChainId,
        toToken: lastStep.action.toToken,
        toAddress: lastStep.action.toAddress,
        slippage: 3.0,
      },
      estimate: {
        type: 'lifi',
        fromAmount: firstStep.estimate.fromAmount,
        toAmount: lastStep.estimate.toAmount,
        toAmountMin: lastStep.estimate.toAmount,
        feeCosts: [],
        gasCosts: [],
      },
      includedSteps: route
    }

    return [lifiStep]
  })
}

export const lifinance = {
  supportedChains: supportedChains,
  executeLifi: executeLifi,
  parseRoutes: parseRoutes,
}
