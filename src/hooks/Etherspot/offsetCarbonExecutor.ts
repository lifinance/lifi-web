import { Web3Provider } from '@ethersproject/providers'
import { CoinKey, findDefaultToken } from '@lifi/sdk'
import { useWeb3React } from '@web3-react/core'
import BigNumber from 'bignumber.js'
import { ethers } from 'ethers'
import { GatewayBatchStates, Sdk } from 'etherspot'
import { useState } from 'react'

import { getRpcProvider } from '../../components/web3/connectors'
import { KLIMA_CARBON_OFFSET_CONTRACT, TOUCAN_BCT_ADDRESS } from '../../constants'
import LiFi from '../../LiFi'
import { useBeneficiaryInfo } from '../../providers/ToSectionCarbonOffsetProvider'
import {
  getFeeTransferTransactionBasedOnAmount,
  getOffsetCarbonTransaction,
  getSetAllowanceTransaction,
} from '../../services/etherspotTxService'
import { switchChain } from '../../services/metamask'
import { ChainId, Execution, ExtendedRouteOptional, getChainById, Process, Step } from '../../types'

export const useOffsetCarbonExecutor = () =>
  // eslint-disable-next-line max-params
  {
    const beneficiaryInfo = useBeneficiaryInfo()

    const web3 = useWeb3React<Web3Provider>()

    const [etherspotStepExecution, setEtherspotStepExecution] = useState<Execution>()

    const resetEtherspotExecution = () => {
      setEtherspotStepExecution(undefined)
    }

    const prepareEtherSpotStep = async (
      etherspot: Sdk,
      gasStep: Step,
      stakingStep: Step,
      baseAmount: string,
      // eslint-disable-next-line max-params
    ) => {
      if (!etherspot) {
        throw new Error('Etherspot not initialized.')
      }
      const TOKEN_POLYGON_USDC = findDefaultToken(CoinKey.USDC, ChainId.POL)

      const amount = new BigNumber(baseAmount)

      const amountUsdc = ethers.BigNumber.from(
        amount.shiftedBy(TOKEN_POLYGON_USDC.decimals).toString(),
      )
      const { feeAmount, txFee } = await getFeeTransferTransactionBasedOnAmount(
        TOKEN_POLYGON_USDC,
        ethers.BigNumber.from(baseAmount),
      )
      const amountUsdcToMatic = ethers.utils.parseUnits('0.2', TOKEN_POLYGON_USDC.decimals)
      const amountUsdcToCarbon = amountUsdc.sub(amountUsdcToMatic).sub(feeAmount)

      const gasStepRefreshPromise = LiFi.getQuote({
        fromChain: gasStep.action.fromChainId,
        fromToken: gasStep.action.fromToken.address,
        fromAddress: etherspot.state.accountAddress!,
        fromAmount: amountUsdcToMatic.toString(),
        toChain: gasStep.action.fromChainId,
        toToken: gasStep.action.toToken.address, // hardcode return gastoken
        slippage: gasStep.action.slippage,
        integrator: 'lifi-etherspot',
        allowExchanges: [gasStep.tool],
      })
      const offsetStepPromise = LiFi.getQuote({
        fromChain: stakingStep.action.fromChainId,
        fromToken: stakingStep.action.fromToken.address,
        fromAddress: etherspot.state.accountAddress!,
        fromAmount: amountUsdcToCarbon.toString(),
        toChain: stakingStep.action.fromChainId,
        toToken: stakingStep.action.toToken.address, // hardcode return gastoken
        slippage: gasStep.action.slippage,
        integrator: 'lifi-etherspot',
        allowExchanges: [stakingStep.tool],
      })

      const resolvedPromises = await Promise.all([gasStepRefreshPromise, offsetStepPromise])
      gasStep = resolvedPromises[0]
      stakingStep = resolvedPromises[1]

      if (!gasStep.transactionRequest || !stakingStep.transactionRequest) {
        throw new Error('Swap transaction missing')
      }

      // reset gateway batch
      etherspot.clearGatewayBatch()

      const txAllowTotal = await getSetAllowanceTransaction(
        gasStep.action.fromToken.address,
        gasStep.estimate.approvalAddress as string,
        ethers.BigNumber.from(baseAmount),
      )
      await etherspot.batchExecuteAccountTransaction({
        to: txAllowTotal.to as string,
        data: txAllowTotal.data as string,
      })

      // Swap for gas
      await etherspot.batchExecuteAccountTransaction({
        to: gasStep.transactionRequest.to as string,
        data: gasStep.transactionRequest.data as string,
      })
      // Collect fee
      await etherspot.batchExecuteAccountTransaction({
        to: txFee.to as string,
        data: txFee.data as string,
      })

      const amountUSDC = new BigNumber(stakingStep.action.fromAmount)
      const safetyMargin = new BigNumber(
        ethers.utils.parseUnits('1.1', stakingStep.action.fromToken.decimals).toString(),
      )
      const amountUSDCAllowance = amountUSDC.multipliedBy(safetyMargin).toString()
      // approve BCT: e.g. https://polygonscan.com/tx/0xb1aca780869956f7a79d9915ff58fd47acbaf9b34f0eb13f9b18d1772f1abef2
      const txAllow = await getSetAllowanceTransaction(
        stakingStep.action.fromToken.address,
        KLIMA_CARBON_OFFSET_CONTRACT,
        amountUSDCAllowance,
      )

      await etherspot.batchExecuteAccountTransaction({
        to: txAllow.to as string,
        data: txAllow.data as string,
      })

      // retire BCT: e.g. https://polygonscan.com/tx/0x5c392aa3487a1fa9e617c5697fe050d9d85930a44508ce74c90caf1bd36264bf
      const amountBCT = stakingStep.estimate.toAmountMin
      const txOffset = await getOffsetCarbonTransaction({
        address: web3.account!,
        amountInCarbon: false,
        quantity: amountBCT,
        inputTokenAddress: gasStep.action.fromToken.address,
        retirementTokenAddress: TOUCAN_BCT_ADDRESS,
        beneficiaryAddress: beneficiaryInfo.beneficiaryAddress || web3.account!,
        beneficiaryName: beneficiaryInfo.beneficiaryName,
        retirementMessage: beneficiaryInfo.retirementMessage,
      })

      await etherspot.batchExecuteAccountTransaction({
        to: txOffset.to as string,
        data: txOffset.data as string,
      })
    }

    const executeEtherspotStep = async (
      etherspot: Sdk,
      gasStep: Step,
      stakingStep: Step,
      baseAmount: string,
      // eslint-disable-next-line max-params
    ) => {
      const processList: Process[] = []

      // FIXME: My be needed if user is bridging from chain which is not supported by etherspot
      if (!etherspot) {
        processList.push({
          type: 'SWITCH_CHAIN',
          message: 'Switch Chain',
          startedAt: Date.now(),
          status: 'CHAIN_SWITCH_REQUIRED',
        })

        setEtherspotStepExecution((execution) => ({
          ...execution,
          status: 'CHAIN_SWITCH_REQUIRED',
          process: [...processList],
        }))

        await switchChain(ChainId.POL)
        const signer = web3.library!.getSigner()
        if ((await signer.getChainId()) !== ChainId.POL) {
          throw Error('Chain was not switched!')
        }

        processList.map((process) => {
          if (process.type === 'SWITCH_CHAIN') {
            process.status = 'DONE'
            process.doneAt = Date.now()
          }
          return process
        })
      }
      if (!etherspot) {
        throw new Error('Etherspot not initialized.')
      }

      processList.push({
        type: 'TRANSACTION',
        message: 'Initialize Etherspot',
        startedAt: Date.now(),
        status: 'PENDING',
      })

      setEtherspotStepExecution((execution) => ({
        ...execution,
        status: 'PENDING',
        process: [...processList],
      }))
      await prepareEtherSpotStep(etherspot, gasStep, stakingStep, baseAmount)

      await etherspot.estimateGatewayBatch()

      processList.map((process) => {
        if (process.type === 'TRANSACTION') {
          process.status = 'DONE'
          process.doneAt = Date.now()
        }
        return process
      })
      processList.push({
        type: 'SWAP',
        message: 'Provide Signature',
        startedAt: Date.now(),
        status: 'ACTION_REQUIRED',
      })

      setEtherspotStepExecution((execution) => ({
        ...execution,
        status: 'ACTION_REQUIRED',
        process: [...processList],
      }))
      let batch = await etherspot.submitGatewayBatch()
      processList.map((process) => {
        if (process.type === 'SWAP') {
          process.status = 'DONE'
          process.doneAt = Date.now()
        }
        return process
      })
      processList.push({
        type: 'RECEIVING_CHAIN',
        message: 'Wait For Execution',
        startedAt: Date.now(),
        status: 'PENDING',
      })

      setEtherspotStepExecution((execution) => ({
        ...execution,
        status: 'PENDING',
        process: [...processList],
      }))

      // info: batch.state seams to wait for a lot of confirmations (6 minutes) before changing to 'Sent'
      let hasTransaction = !!(batch.transaction && batch.transaction.hash)
      while (!hasTransaction) {
        try {
          batch = await etherspot.getGatewaySubmittedBatch({
            hash: batch.hash,
          })
        } catch (e) {
          // ignore failed requests and try again
          // eslint-disable-next-line no-console
          console.error(e)
        }

        if (batch.state === GatewayBatchStates.Reverted) {
          // eslint-disable-next-line no-console
          console.error(batch)
          throw new Error('Execution Reverted')
        }

        hasTransaction = !!(batch.transaction && batch.transaction.hash)
        if (!hasTransaction) {
          await new Promise((resolve) => {
            setTimeout(resolve, 3000)
          })
        }
      }

      // Add Transaction
      const chain = getChainById(ChainId.POL)
      processList.map((process) => {
        if (process.type === 'RECEIVING_CHAIN') {
          process.txHash = batch.transaction.hash
          process.txLink = chain.metamask.blockExplorerUrls[0] + 'tx/' + batch.transaction.hash
        }
        return process
      })

      setEtherspotStepExecution((execution) => ({
        ...execution,
        status: 'PENDING',
        process: [...processList],
      }))

      // Wait for Transaction
      const provider = await getRpcProvider(ChainId.POL)
      let receipt
      while (!receipt) {
        try {
          const tx = await provider.getTransaction(batch.transaction.hash!)
          if (tx) {
            receipt = await tx.wait()
          }
        } catch (e) {
          // ignore failed requests and try again
          // eslint-disable-next-line no-console
          console.error(e)
        }

        if (!receipt) {
          await new Promise((resolve) => {
            setTimeout(resolve, 3000)
          })
        }
      }

      processList.map((process) => {
        if (process.type === 'RECEIVING_CHAIN') {
          process.status = 'DONE'
          process.message = 'Offsetting Successful'
          process.txHash = batch.transaction.hash
          process.txLink = chain.metamask.blockExplorerUrls[0] + 'tx/' + batch.transaction.hash
          process.doneAt = Date.now()
        }
        return process
      })

      const stepExecution: Execution = {
        status: 'PENDING',
        process: processList,
      }
      setEtherspotStepExecution((execution) => ({
        ...execution,
        ...stepExecution,
      }))
      return stepExecution
    }

    const finalizeEtherSpotExecution = (stepExecution: Execution, toAmount: string) => {
      const doneList = stepExecution.process.map((p) => {
        p.status = 'DONE'
        return p
      })

      setEtherspotStepExecution((execution) => ({
        ...execution,
        status: 'DONE',
        process: [...doneList],
        toAmount,
      }))
    }

    const handlePotentialEtherSpotError = (
      e: any,
      route: ExtendedRouteOptional,
      simpleTransferExecution?: Execution,
    ) => {
      if (
        route.lifiRoute?.steps.some((step) => step.execution?.status === 'FAILED') ||
        (route.simpleTransfer && simpleTransferExecution?.status !== 'DONE')
      ) {
        return
      }

      if (!etherspotStepExecution) {
        setEtherspotStepExecution(() => ({
          status: 'FAILED',
          process: [
            {
              status: 'FAILED',
              type: 'TRANSACTION',
              message: 'Prepare Transaction',
              startedAt: Date.now(),
              doneAt: Date.now(),
              error: {
                message: e.errorMessage,
                code: e.code,
              },
            },
          ],
        }))
      } else {
        const processList = etherspotStepExecution.process
        processList[processList.length - 1].status = 'FAILED'
        processList[processList.length - 1].errorMessage = e.errorMessage
        processList[processList.length - 1].doneAt = Date.now()

        setEtherspotStepExecution((execution) => ({
          ...execution,
          status: 'FAILED',
          process: [...processList],
        }))
      }
    }

    return {
      etherspotStepExecution,
      executeEtherspotStep,
      resetEtherspotExecution,
      handlePotentialEtherSpotError,
      finalizeEtherSpotExecution,
    }
  }
