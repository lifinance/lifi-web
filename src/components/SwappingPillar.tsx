import { ArrowRightOutlined, LoadingOutlined, PauseCircleOutlined } from '@ant-design/icons'
import { Web3Provider } from '@ethersproject/providers'
import { ChainId, ExecutionSettings, StepTool } from '@lifinance/sdk'
import { useWeb3React } from '@web3-react/core'
import {
  Avatar,
  Button,
  Divider,
  Modal,
  Row,
  Space,
  Spin,
  Timeline,
  Tooltip,
  Typography,
} from 'antd'
import BigNumber from 'bignumber.js'
import { BigNumberish, constants, ethers } from 'ethers'
import { Sdk } from 'etherspot'
import { useEffect, useState } from 'react'
import { useMediaQuery } from 'react-responsive'
import { Link } from 'react-router-dom'

import walletIcon from '../assets/wallet.png'
import {
  erc20Abi,
  KLIMA_ADDRESS,
  sKLIMA_ADDRESS,
  STAKE_KLIMA_CONTRACT_ADDRESS,
  stakeKlimaAbi,
} from '../constants'
import LiFi from '../LiFi'
import { isWalletConnectWallet, storeRoute } from '../services/localStorage'
import { switchChain, switchChainAndAddToken } from '../services/metamask'
import Notification, { NotificationType } from '../services/notifications'
import { renderProcessError, renderProcessMessage } from '../services/processRenderer'
import { formatTokenAmount, parseSecondsAsTime } from '../services/utils'
import {
  ChainKey,
  findTool,
  getChainById,
  getChainByKey,
  isCrossStep,
  isLifiStep,
  Route,
  Step,
  TokenAmount,
} from '../types'
import Clock from './Clock'
import LoadingIndicator from './LoadingIndicator'
import { WalletConnectChainSwitchModal } from './WalletConnectChainSwitchModal'

interface SwapSettings {
  infiniteApproval: boolean
}

interface SwappingProps {
  route: { lifiRoute: Route; gasStep: Step; stakingStep: Step }
  etherspot: Sdk
  settings: SwapSettings
  updateRoute: Function
  onSwapDone: Function
  fixedRecipient?: boolean
}

const getSetAllowanceTransaction = async (
  tokenAddress: string,
  approvalAddress: string,
  amount: BigNumberish,
) => {
  const erc20 = new ethers.Contract(tokenAddress, erc20Abi)
  return erc20.populateTransaction.approve(approvalAddress, amount)
}

const getStakeKlimaTransaction = (amount: BigNumberish) => {
  const contract = new ethers.Contract(STAKE_KLIMA_CONTRACT_ADDRESS, stakeKlimaAbi)
  return contract.populateTransaction.stake(amount)
}
const getTransferTransaction = async (
  tokenAddress: string,
  toAddress: string,
  amount: BigNumberish,
) => {
  const erc20 = new ethers.Contract(tokenAddress, erc20Abi)
  return erc20.populateTransaction.transfer(toAddress, amount)
}

const getFinalBalance = (account: string, route: Route): Promise<TokenAmount | null> => {
  const lastStep = route.steps[route.steps.length - 1]
  const { toToken } = getReceivingInfo(lastStep)
  return LiFi.getTokenBalance(account, toToken)
}

const getReceivingInfo = (step: Step) => {
  const toChain = getChainById(step.action.toChainId)
  const toToken = step.action.toToken
  return { toChain, toToken }
}

const SwappingPillar = ({
  route,
  etherspot,
  updateRoute,
  settings,
  onSwapDone,
  fixedRecipient = false,
}: SwappingProps) => {
  const { steps } = route.lifiRoute

  const isMobile = useMediaQuery({ query: `(max-width: 760px)` })

  const [swapStartedAt, setSwapStartedAt] = useState<number>()
  const [swapDoneAt, setSwapDoneAt] = useState<number>()
  const [isSwapping, setIsSwapping] = useState<boolean>(false)
  const [alerts] = useState<Array<JSX.Element>>([])
  const [finalTokenAmount, setFinalTokenAmount] = useState<TokenAmount | null>()
  const [showWalletConnectChainSwitchModal, setShowWalletConnectChainSwitchModal] = useState<{
    show: boolean
    chainId: number
    promiseResolver?: Function
  }>({ show: false, chainId: 1 })

  // Wallet
  const web3 = useWeb3React<Web3Provider>()

  useEffect(() => {
    // check if route is eligible for automatic resuming
    const allDone = steps.every((step) => step.execution?.status === 'DONE')
    const isFailed = steps.some((step) => step.execution?.status === 'FAILED')

    const alreadyStarted = steps.some((step) => step.execution)
    if (!allDone && !isFailed && alreadyStarted) {
      resumeExecution()
    }

    // move execution to background when modal is closed
    return function cleanup() {
      LiFi.moveExecutionToBackground(route.lifiRoute)
    }
  }, [])

  const parseExecution = (step: Step) => {
    if (!step.execution) {
      return []
    }
    return step.execution.process.map((process, index, processList) => {
      const type =
        process.status === 'DONE' ? 'success' : process.status === 'FAILED' ? 'danger' : undefined
      const hasFailed = process.status === 'FAILED'
      const isLastPendingProcess = index === processList.length - 1 && process.status === 'PENDING'
      return (
        <span key={index} style={{ display: 'flex' }}>
          <Typography.Text
            type={type}
            style={{ maxWidth: 250 }}
            className={isSwapping && isLastPendingProcess ? 'flashing' : undefined}>
            <p>{renderProcessMessage(process)}</p>

            {hasFailed && (
              <Typography.Text type="secondary" style={{ whiteSpace: 'pre-wrap' }}>
                {renderProcessError(step, process)}
              </Typography.Text>
            )}
          </Typography.Text>
          <Typography.Text style={{ marginLeft: 'auto', minWidth: 35 }}>
            <Clock
              startedAt={process.startedAt}
              successAt={process.doneAt}
              failedAt={process.failedAt}
            />
          </Typography.Text>
        </span>
      )
    })
  }

  const getChainAvatar = (chainKey: ChainKey) => {
    const chain = getChainByKey(chainKey)
    return (
      <Tooltip title={chain.name}>
        <Avatar size="small" src={chain.logoURI} alt={chain.name}></Avatar>
      </Tooltip>
    )
  }

  const getAvatar = (toolKey: StepTool) => {
    const tool = findTool(toolKey)
    return (
      <Tooltip title={tool?.name}>
        <Avatar size="small" src={tool?.logoURI} alt={tool?.name}></Avatar>
      </Tooltip>
    )
  }

  const parseStepToTimeline = (step: Step, index: number) => {
    const executionSteps = parseExecution(step)
    const isDone = step.execution && step.execution.status === 'DONE'
    const isLoading = isSwapping && step.execution && step.execution.status === 'PENDING'
    const isPaused = !isSwapping && step.execution && step.execution.status === 'PENDING'
    const color = isDone ? 'green' : step.execution ? 'blue' : 'gray'
    const executionDuration = !!step.estimate.executionDuration && (
      <>
        <br />
        <span>Estimated duration: {parseSecondsAsTime(step.estimate.executionDuration)} min</span>
      </>
    )

    const executionItem = [
      <Timeline.Item
        position={isMobile ? 'right' : 'left'}
        key={index + '_right'}
        color={color}
        dot={isLoading ? <LoadingOutlined /> : isPaused ? <PauseCircleOutlined /> : null}>
        {executionSteps}
      </Timeline.Item>,
    ]

    switch (step.type) {
      case 'swap': {
        return [
          <Timeline.Item
            position={isMobile ? 'right' : 'right'}
            key={index + '_left'}
            color={color}>
            <h4>Swap on {getAvatar(step.tool)}</h4>
            <span>
              {formatTokenAmount(step.action.fromToken, step.estimate?.fromAmount)}{' '}
              <ArrowRightOutlined />{' '}
              {formatTokenAmount(step.action.toToken, step.estimate?.toAmount)}
            </span>
            {executionDuration}
          </Timeline.Item>,
          !!step.execution || route.lifiRoute.steps.length - 1 === index ? executionItem : <></>,
        ]
      }

      case 'cross': {
        const { action, estimate } = step
        return [
          <Timeline.Item
            position={isMobile ? 'right' : 'right'}
            key={index + '_left'}
            color={color}>
            <h4>
              Transfer from {getChainAvatar(getChainById(action.fromChainId).key)} to{' '}
              {getChainAvatar(getChainById(action.toChainId).key)} via {getAvatar(step.tool)}
            </h4>
            <span>
              {formatTokenAmount(action.fromToken, estimate.fromAmount)} <ArrowRightOutlined />{' '}
              {formatTokenAmount(action.toToken, estimate.toAmount)}
            </span>
            {executionDuration}
          </Timeline.Item>,
          !!step.execution || route.lifiRoute.steps.length - 1 === index ? executionItem : <></>,
        ]
      }

      case 'lifi': {
        return [
          <Timeline.Item
            position={isMobile ? 'right' : 'right'}
            key={index + '_left'}
            color={color}>
            <h4>
              LiFi Contract from {getChainAvatar(getChainById(step.action.fromChainId).key)} to{' '}
              {getChainAvatar(getChainById(step.action.toChainId).key)} via {getAvatar(step.tool)}
            </h4>
            <span>
              {formatTokenAmount(step.action.fromToken, step.estimate?.fromAmount)}{' '}
              <ArrowRightOutlined />{' '}
              {formatTokenAmount(step.action.toToken, step.estimate?.toAmount)}
            </span>
            {executionDuration}
          </Timeline.Item>,
          !!step.execution || route.lifiRoute.steps.length - 1 === index ? executionItem : <></>,
        ]
      }

      default:
        // eslint-disable-next-line no-console
        console.warn('should never reach here')
    }
  }

  const prepareEtherSpotStep = async () => {
    const tokenPolygonKLIMA = await LiFi.getToken(ChainId.POL, KLIMA_ADDRESS)!
    const tokenPolygonSKLIMA = await LiFi.getToken(ChainId.POL, sKLIMA_ADDRESS)!
    if (etherspot && route.gasStep.transactionRequest && route.stakingStep.transactionRequest) {
      const totalAmount = ethers.BigNumber.from(route.gasStep.estimate.fromAmount).add(
        route.stakingStep.estimate.fromAmount,
      )
      const txAllowTotal = await getSetAllowanceTransaction(
        route.lifiRoute.toToken.address,
        route.gasStep.estimate.approvalAddress as string,
        totalAmount,
      )

      await etherspot.batchExecuteAccountTransaction({
        to: txAllowTotal.to as string,
        data: txAllowTotal.data as string,
      })

      // Swap
      await etherspot.batchExecuteAccountTransaction({
        to: route.gasStep.transactionRequest.to as string,
        data: route.gasStep.transactionRequest.data as string,
      })

      await etherspot.batchExecuteAccountTransaction({
        to: route.stakingStep.transactionRequest.to as string,
        data: route.stakingStep.transactionRequest.data as string,
      })
      const amountKlima = route.stakingStep.estimate.toAmountMin

      // approve KLIMA: e.g. https://polygonscan.com/tx/0xb1aca780869956f7a79d9915ff58fd47acbaf9b34f0eb13f9b18d1772f1abef2
      const txAllow = await getSetAllowanceTransaction(
        tokenPolygonKLIMA!.address,
        STAKE_KLIMA_CONTRACT_ADDRESS,
        amountKlima,
      )
      await etherspot.batchExecuteAccountTransaction({
        to: txAllow.to as string,
        data: txAllow.data as string,
      })

      // stake KLIMA: e.g. https://polygonscan.com/tx/0x5c392aa3487a1fa9e617c5697fe050d9d85930a44508ce74c90caf1bd36264bf
      const txStake = await getStakeKlimaTransaction(amountKlima)
      await etherspot.batchExecuteAccountTransaction({
        to: txStake.to as string,
        data: txStake.data as string,
      })

      const txTransfer = await getTransferTransaction(
        tokenPolygonSKLIMA!.address,
        web3.account!,
        amountKlima,
      )
      await etherspot.batchExecuteAccountTransaction({
        to: txTransfer.to as string,
        data: txTransfer.data as string,
      })
    }
  }

  const startCrossChainSwap = async () => {
    if (!web3.account || !web3.library) return
    const signer = web3.library.getSigner()

    const executionSettings: ExecutionSettings = {
      updateCallback: updateCallback,
      switchChainHook: switchChainHook,
      infiniteApproval: settings.infiniteApproval,
    }
    storeRoute(route.lifiRoute)
    setIsSwapping(true)
    setSwapStartedAt(Date.now())
    try {
      await LiFi.executeRoute(signer, route.lifiRoute, executionSettings)
      // console.log(etherspot.state.accountAddress)

      await prepareEtherSpotStep()
      const gatewayBatch = await etherspot.estimateGatewayBatch()
      // console.log(gatewayBatch)
      const batch = await etherspot.submitGatewayBatch()
      // console.log(batch)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Execution failed!', route.lifiRoute)
      // eslint-disable-next-line no-console
      console.error(e)
      Notification.showNotification(NotificationType.TRANSACTION_ERROR)
      setIsSwapping(false)
      return
    }
    setFinalTokenAmount(await getFinalBalance(web3.account!, route.lifiRoute))
    setIsSwapping(false)
    setSwapDoneAt(Date.now())
    Notification.showNotification(NotificationType.TRANSACTION_SUCCESSFULL)
    onSwapDone()
  }

  const resumeExecution = async () => {
    if (!web3.account || !web3.library) return

    const executionSettings: ExecutionSettings = {
      updateCallback,
      switchChainHook,
      infiniteApproval: settings.infiniteApproval,
    }

    setIsSwapping(true)
    try {
      await LiFi.resumeRoute(web3.library.getSigner(), route.lifiRoute, executionSettings)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Execution failed!', route)
      // eslint-disable-next-line no-console
      console.error(e)
      Notification.showNotification(NotificationType.TRANSACTION_ERROR)
      setIsSwapping(false)
      return
    }
    setFinalTokenAmount(await getFinalBalance(web3.account!, route.lifiRoute))
    setIsSwapping(false)
    setSwapDoneAt(Date.now())
    Notification.showNotification(NotificationType.TRANSACTION_SUCCESSFULL)
    onSwapDone()
  }

  const restartCrossChainSwap = async () => {
    // remove failed

    for (let index = 0; index < steps.length; index++) {
      const stepHasFailed = steps[index].execution?.status === 'FAILED'
      // check if the step has been cancelled which is a "failed" state
      const stepHasBeenCancelled = steps[index].execution?.process.some(
        (process) => process.status === 'CANCELLED',
      )

      if (steps[index].execution && (stepHasFailed || stepHasBeenCancelled)) {
        steps[index].execution!.status = 'RESUME'
        steps[index].execution!.process.pop() // remove last (failed) process
        updateRoute(route.lifiRoute)
      }
    }
    // start again
    resumeExecution()
  }

  const switchChainHook = async (requiredChainId: number) => {
    if (!web3.account || !web3.library) return

    if (isWalletConnectWallet(web3.account)) {
      let promiseResolver
      const signerAwaiter = new Promise<void>((resolve) => (promiseResolver = resolve))

      setShowWalletConnectChainSwitchModal({
        show: true,
        chainId: requiredChainId,
        promiseResolver,
      })

      await signerAwaiter
      return web3.library.getSigner()
    }

    if ((await web3.library.getSigner().getChainId()) !== requiredChainId) {
      // Fallback is Metamask
      const switched = await switchChain(requiredChainId)
      if (!switched) {
        throw new Error('Chain was not switched')
      }
    }
    return web3.library.getSigner()
  }

  // called on every execution status change
  const updateCallback = (updatedRoute: Route) => {
    storeRoute(updatedRoute)
    updateRoute(updatedRoute)
  }

  const getMainButton = () => {
    // PENDING
    if (isSwapping) {
      return <></>
    }
    const isCrossChainSwap = !!steps.find((step) => isCrossStep(step) || isLifiStep(step))

    // DONE
    const isDone = steps.filter((step) => step.execution?.status !== 'DONE').length === 0
    if (isDone) {
      const lastStep = steps[steps.length - 1]
      const { toChain } = getReceivingInfo(lastStep)
      const receivedAmount = new BigNumber(lastStep.execution?.toAmount || '0')
      const successMessage = !!finalTokenAmount ? (
        <>
          {!receivedAmount.isZero() &&
            (!fixedRecipient ? (
              <>
                <Typography.Text>
                  You received {receivedAmount.shiftedBy(-finalTokenAmount.decimals).toFixed(4)}
                  {` ${finalTokenAmount.symbol}`}
                </Typography.Text>
                <br />
              </>
            ) : (
              <>
                <Typography.Text>
                  You sent {receivedAmount.shiftedBy(-finalTokenAmount.decimals).toFixed(20)}
                  {` ${finalTokenAmount.symbol}`}
                </Typography.Text>
                <br />
              </>
            ))}
          {!fixedRecipient && (
            <Typography.Text
              type={!receivedAmount.isZero() ? 'secondary' : undefined}
              style={{ fontSize: !receivedAmount.isZero() ? 12 : 14 }}>
              {'You now have '}
              {new BigNumber(finalTokenAmount.amount).toFixed(4)}
              {` ${finalTokenAmount.symbol}`}
              {` on ${toChain.name}`}
            </Typography.Text>
          )}
        </>
      ) : (
        ''
      )

      return (
        <Space direction="vertical">
          <Typography.Text strong>Swap Successful!</Typography.Text>
          {finalTokenAmount &&
            (finalTokenAmount.address === constants.AddressZero ? (
              <span>{successMessage}</span>
            ) : (
              <Tooltip title="Click to add this token to your wallet.">
                <span
                  style={{ cursor: 'copy' }}
                  onClick={() => switchChainAndAddToken(toChain.id, finalTokenAmount)}>
                  {successMessage}
                </span>
              </Tooltip>
            ))}
          {!fixedRecipient && (
            <Link to="/dashboard">
              <Button type="link">Dashboard</Button>
            </Link>
          )}
        </Space>
      )
    }

    // FAILED
    const isFailed = steps.some((step) => step.execution?.status === 'FAILED')
    if (isFailed) {
      return (
        <Button type="primary" onClick={() => restartCrossChainSwap()} style={{ marginTop: 10 }}>
          Restart from Failed Step
        </Button>
      )
    }

    const chainSwitchRequired = steps.some(
      (step) => step.execution?.status === 'CHAIN_SWITCH_REQUIRED',
    )
    if (chainSwitchRequired) {
      return <></>
    }

    // NOT_STARTED
    return (
      <Button type="primary" onClick={() => startCrossChainSwap()} style={{ marginTop: 10 }}>
        {isCrossChainSwap ? 'Start Cross Chain Swap' : 'Start Swap'}
      </Button>
    )
  }

  const getCurrentProcess = () => {
    for (const step of steps) {
      if (step.execution?.process) {
        for (const process of step.execution?.process) {
          if (process.status === 'ACTION_REQUIRED' || process.status === 'PENDING') {
            return process
          }
        }
      }
    }
    return null
  }

  const currentProcess = getCurrentProcess()

  const parseEtherspotItem = () => {
    const lastLiFiStep = route.lifiRoute.steps[route.lifiRoute.steps.length - 1]
    const index = route.lifiRoute.steps.length
    //const isDone = false //step.execution && step.execution.status === 'DONE'
    const isLoading = false //isSwapping && step.execution && step.execution.status === 'PENDING'
    const isPaused = false //!isSwapping && step.execution && step.execution.status === 'PENDING'
    const color = 'blue' //isDone ? 'green' : step.execution ? 'blue' : 'gray'
    // const executionDuration = !!step.estimate.executionDuration && (
    //   <>
    //     <br />
    //     <span>Estimated duration: {parseSecondsAsTime(step.estimate.executionDuration)} min</span>
    //   </>
    // )
    return [
      <Timeline.Item position={isMobile ? 'right' : 'right'} key={index + '_left'} color={color}>
        <h4>Swap on {'Pillar'}</h4>
        <span>
          {formatTokenAmount(lastLiFiStep.action.toToken, lastLiFiStep.estimate?.toAmount)}{' '}
          <ArrowRightOutlined />{' '}
          {formatTokenAmount(
            route.stakingStep.action.toToken,
            route.stakingStep.estimate?.toAmount,
          )}
        </span>
        {/* {executionDuration} */}
      </Timeline.Item>,
      <Timeline.Item
        position={isMobile ? 'right' : 'left'}
        key={index + '_right'}
        color={color}
        dot={isLoading ? <LoadingOutlined /> : isPaused ? <PauseCircleOutlined /> : null}>
        {/* {executionSteps} */}
      </Timeline.Item>,
    ]
  }

  return (
    <>
      {alerts}
      <br />

      <Timeline mode={isMobile ? 'left' : 'alternate'} className="swapping-modal-timeline">
        {/* Steps */}
        {steps.map(parseStepToTimeline)}
        {parseEtherspotItem()}
      </Timeline>

      <div style={{ display: 'flex', backgroundColor: 'rgba(255,255,255, 0)' }}>
        <Typography.Text style={{ marginLeft: 'auto', marginRight: 5 }}>
          {swapStartedAt ? (
            <span className="totalTime">
              <Clock startedAt={swapStartedAt} successAt={swapDoneAt} />
            </span>
          ) : (
            <span>&nbsp;</span>
          )}
        </Typography.Text>
      </div>

      <Divider />

      <div className="swapp-modal-footer">
        <div style={{ textAlign: 'center', transform: 'scale(1.3)' }}>{getMainButton()}</div>

        {isSwapping && currentProcess && currentProcess.status === 'ACTION_REQUIRED' && (
          <>
            <Row justify="center" style={{ marginBottom: 6 }}>
              <Typography.Text>{renderProcessMessage(currentProcess)}</Typography.Text>
            </Row>
            <Row justify="center">
              <img src={walletIcon} alt="Please Check Your Wallet" />
            </Row>
          </>
        )}

        {isSwapping && currentProcess && currentProcess.status === 'PENDING' && (
          <>
            <Row justify="center">
              <Typography.Text className="flashing">
                {renderProcessMessage(currentProcess)}
              </Typography.Text>
            </Row>
            <Row style={{ marginTop: 20 }} justify="center">
              <Spin indicator={<LoadingIndicator />} />
            </Row>
          </>
        )}
        <Modal
          className="wallet-selection-modal"
          visible={showWalletConnectChainSwitchModal.show}
          onOk={() =>
            setShowWalletConnectChainSwitchModal({
              show: false,
              chainId: 1,
            })
          }
          onCancel={() =>
            setShowWalletConnectChainSwitchModal({
              show: false,
              chainId: 1,
            })
          }
          footer={null}>
          <WalletConnectChainSwitchModal
            chainId={showWalletConnectChainSwitchModal.chainId}
            okHandler={() => {
              if (showWalletConnectChainSwitchModal.promiseResolver) {
                showWalletConnectChainSwitchModal.promiseResolver()
              }
              setShowWalletConnectChainSwitchModal({
                show: false,
                chainId: 1,
              })
            }}
          />
        </Modal>
      </div>
    </>
  )
}

export default SwappingPillar