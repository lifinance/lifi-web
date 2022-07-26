import {
  ArrowRightOutlined,
  EditOutlined,
  LoadingOutlined,
  PauseCircleOutlined,
} from '@ant-design/icons'
import { Web3Provider } from '@ethersproject/providers'
import { AcceptSlippageUpdateHookParams, Execution, ExecutionSettings, Token } from '@lifi/sdk'
import { useWeb3React } from '@web3-react/core'
import { Button, Divider, Modal, Row, Space, Spin, Timeline, Tooltip, Typography } from 'antd'
import { constants } from 'ethers'
import { Sdk } from 'etherspot'
import { useEffect, useState } from 'react'

import { TOUCAN_BCT_ADDRESS } from '../../constants'
import { useOffsetCarbonExecutor } from '../../hooks/Etherspot/offsetCarbonExecutor'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useStepReturnInfo } from '../../hooks/useStepReturnInfo'
import LiFi from '../../LiFi'
import { isWalletConnectWallet } from '../../services/localStorage'
import { switchChain, switchChainAndAddToken } from '../../services/metamask'
import Notification, { NotificationType } from '../../services/notifications'
import { renderProcessError, renderProcessMessage } from '../../services/processRenderer'
import { formatTokenAmount, parseSecondsAsTime } from '../../services/utils'
import { ExtendedRoute, getChainById, isCrossStep, isLifiStep, Route, Step } from '../../types'
import { getChainAvatar, getToolAvatar } from '../Avatars/Avatars'
import Clock from '../Clock'
import LoadingIndicator from '../LoadingIndicator'
import { WalletConnectChainSwitchModal } from '../WalletConnectChainSwitchModal'

const TOUCAN_BCT_TOKEN = {
  symbol: 'BCT',
  decimals: 18,
  name: 'Toucan Protocol: Base Carbon Tonne',
  chainId: 137,
  address: TOUCAN_BCT_ADDRESS,
}

interface SwapSettings {
  infiniteApproval: boolean
}

interface SwappingProps {
  route: ExtendedRoute
  etherspot?: Sdk
  settings: SwapSettings
  updateRoute: Function
  onSwapDone: Function
  fixedRecipient?: boolean
}

const SwappingCarbonOffset = ({
  route,
  etherspot,
  updateRoute,
  settings,
  onSwapDone,
}: SwappingProps) => {
  const {
    etherspotStepExecution,
    executeEtherspotStep,
    resetEtherspotExecution,
    handlePotentialEtherSpotError,
    finalizeEtherSpotExecution,
  } = useOffsetCarbonExecutor()

  const isMobile = useIsMobile()

  const [localRoute, setLocalRoute] = useState<ExtendedRoute>(route)

  const [swapStartedAt, setSwapStartedAt] = useState<number>()
  const [swapDoneAt, setSwapDoneAt] = useState<number>()
  const [isSwapping, setIsSwapping] = useState<boolean>(false)
  const [alerts] = useState<Array<JSX.Element>>([])
  const [showWalletConnectChainSwitchModal, setShowWalletConnectChainSwitchModal] = useState<{
    show: boolean
    chainId: number
    promiseResolver?: Function
  }>({ show: false, chainId: 1 })
  const [showAcceptSlippageUpdateModal, setShowAcceptSlippageUpdateModal] = useState<{
    show: boolean
    oldToAmount?: string
    newToAmount?: string
    toToken?: Token
    oldSlippage?: number
    newSlippage?: number
    promiseResolver?: Function
  }>({ show: false })
  const [transferExecutionError, setTransferExecutionError] = useState<any>()

  // Wallet
  const web3 = useWeb3React<Web3Provider>()

  const routeReturnInfo = useStepReturnInfo({
    ...localRoute.stakingStep,
    execution: etherspotStepExecution,
  })

  useEffect(() => {
    setLocalRoute((oldRoute) => ({ ...oldRoute, ...route }))
  }, [route])

  useEffect(() => {
    // check if route is eligible for automatic resuming
    const allDone = localRoute.lifiRoute.steps.every((step) => step.execution?.status === 'DONE')
    const isFailed = localRoute.lifiRoute.steps.some((step) => step.execution?.status === 'FAILED')

    const alreadyStarted = localRoute.lifiRoute.steps.some((step) => step.execution)
    if (!allDone && !isFailed && alreadyStarted) {
      resumeExecution()
    }

    // move execution to background when modal is closed
    return function cleanup() {
      LiFi.moveExecutionToBackground(localRoute.lifiRoute)
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
                {renderProcessError(process)}
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
            <h4>Swap on {getToolAvatar(step)}</h4>
            <span>
              {formatTokenAmount(step.action.fromToken, step.estimate?.fromAmount)}{' '}
              <ArrowRightOutlined />{' '}
              {formatTokenAmount(step.action.toToken, step.estimate?.toAmount)}
            </span>
            {executionDuration}
          </Timeline.Item>,
          !!step.execution || localRoute.lifiRoute.steps.length - 1 === index ? (
            executionItem
          ) : (
            <></>
          ),
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
              {getChainAvatar(getChainById(action.toChainId).key)} via {getToolAvatar(step)}
            </h4>
            <span>
              {formatTokenAmount(action.fromToken, estimate.fromAmount)} <ArrowRightOutlined />{' '}
              {formatTokenAmount(action.toToken, estimate.toAmount)}
            </span>
            {executionDuration}
          </Timeline.Item>,
          !!step.execution || localRoute.lifiRoute.steps.length - 1 === index ? (
            executionItem
          ) : (
            <></>
          ),
        ]
      }

      case 'lifi': {
        return [
          <Timeline.Item
            position={isMobile ? 'right' : 'right'}
            key={index + '_left'}
            color={color}>
            <h4>
              LI.FI Contract from {getChainAvatar(getChainById(step.action.fromChainId).key)} to{' '}
              {getChainAvatar(getChainById(step.action.toChainId).key)} via {getToolAvatar(step)}
            </h4>
            <span>
              {formatTokenAmount(step.action.fromToken, step.estimate?.fromAmount)}{' '}
              <ArrowRightOutlined />{' '}
              {formatTokenAmount(step.action.toToken, step.estimate?.toAmount)}
            </span>
            {executionDuration}
          </Timeline.Item>,
          !!step.execution || localRoute.lifiRoute.steps.length - 1 === index ? (
            executionItem
          ) : (
            <></>
          ),
        ]
      }

      default:
        // eslint-disable-next-line no-console
        console.warn('should never reach here')
    }
  }

  const startCrossChainSwap = async () => {
    if (!web3.account || !web3.library) return
    const signer = web3.library.getSigner()

    const executionSettings: ExecutionSettings = {
      updateCallback,
      switchChainHook,
      acceptSlippageUpdateHook,
      infiniteApproval: settings.infiniteApproval,
    }
    setIsSwapping(true)
    setSwapStartedAt(Date.now())
    try {
      await LiFi.executeRoute(signer, localRoute.lifiRoute, executionSettings)
      await finalizeEtherSpotStep(
        await executeEtherspotStep(
          etherspot!,
          route.gasStep,
          route.stakingStep,
          route.lifiRoute.toAmountMin,
        ),
      )
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Execution failed!', localRoute.lifiRoute)
      // eslint-disable-next-line no-console
      console.error(e)
      setTransferExecutionError(e)

      Notification.showNotification(NotificationType.TRANSACTION_ERROR)
      setIsSwapping(false)
      return
    }
    setIsSwapping(false)
    setSwapDoneAt(Date.now())
    Notification.showNotification(NotificationType.TRANSACTION_SUCCESSFULL)
    onSwapDone()
  }

  useEffect(() => {
    if (transferExecutionError) {
      handlePotentialEtherSpotError(transferExecutionError, localRoute)
      setTransferExecutionError(undefined)
    }
  }, [transferExecutionError])

  const resumeExecution = async () => {
    if (!web3.account || !web3.library) return

    const executionSettings: ExecutionSettings = {
      updateCallback,
      switchChainHook,
      acceptSlippageUpdateHook,
      infiniteApproval: settings.infiniteApproval,
    }

    setIsSwapping(true)
    try {
      await LiFi.resumeRoute(web3.library.getSigner(), localRoute.lifiRoute, executionSettings)
      await finalizeEtherSpotStep(
        await executeEtherspotStep(
          etherspot!,
          route.gasStep,
          route.stakingStep,
          route.lifiRoute.toAmountMin,
        ),
      )
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Execution failed!', localRoute)
      // eslint-disable-next-line no-console
      console.error(e)
      setTransferExecutionError(e)
      Notification.showNotification(NotificationType.TRANSACTION_ERROR)
      setIsSwapping(false)
      return
    }
    setIsSwapping(false)
    setSwapDoneAt(Date.now())
    Notification.showNotification(NotificationType.TRANSACTION_SUCCESSFULL)
    onSwapDone()
  }

  const restartCrossChainSwap = async () => {
    // remove failed

    for (let index = 0; index < localRoute.lifiRoute.steps.length; index++) {
      const stepHasFailed = localRoute.lifiRoute.steps[index].execution?.status === 'FAILED'
      // check if the step has been cancelled which is a "failed" state
      const stepHasBeenCancelled = localRoute.lifiRoute.steps[index].execution?.process.some(
        (process) => process.status === 'CANCELLED',
      )

      if (localRoute.lifiRoute.steps[index].execution && (stepHasFailed || stepHasBeenCancelled)) {
        localRoute.lifiRoute.steps[index].execution!.status = 'RESUME'
        localRoute.lifiRoute.steps[index].execution!.process.pop() // remove last (failed) process
        updateRoute(route.lifiRoute)
      }
    }
    if (etherspotStepExecution) {
      resetEtherspotExecution()
    }
    // start again
    resumeExecution()
  }

  const finalizeEtherSpotStep = async (stepExecution: Execution) => {
    const toAmount = localRoute.stakingStep.estimate.toAmountMin

    finalizeEtherSpotExecution(stepExecution!, toAmount)
  }
  const acceptSlippageUpdateHook = async (
    params: AcceptSlippageUpdateHookParams,
    // eslint-disable-next-line max-params
  ) => {
    if (!web3.account || !web3.library) return false

    let promiseResolver
    const awaiter = new Promise<boolean>((resolve) => (promiseResolver = resolve))

    setShowAcceptSlippageUpdateModal({
      show: true,
      oldToAmount: params.oldToAmount,
      newToAmount: params.newToAmount,
      toToken: params.toToken,
      oldSlippage: params.oldSlippage,
      newSlippage: params.newSlippage,
      promiseResolver,
    })

    const accept = await awaiter

    return accept
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
    setLocalRoute((route) => ({ ...route, lifiRoute: updatedRoute }))
    updateRoute(updatedRoute)
  }

  const getMainButton = () => {
    // PENDING
    if (isSwapping) {
      return <></>
    }
    const isCrossChainSwap = !!localRoute.lifiRoute.steps.find(
      (step) => isCrossStep(step) || isLifiStep(step),
    )

    // DONE
    const isDone =
      localRoute.lifiRoute.steps.filter((step) => step.execution?.status !== 'DONE').length === 0 &&
      etherspotStepExecution?.status === 'DONE'
    if (isDone) {
      const infoMessage = !!routeReturnInfo?.totalBalanceOfReceivedToken ? (
        <Typography.Text>
          Amount of carbon offsetted{` `}
          {formatTokenAmount(
            routeReturnInfo.receivedToken,
            routeReturnInfo.receivedAmount.toString(),
          )}
        </Typography.Text>
      ) : (
        ''
      )
      return (
        <Space direction="vertical">
          <Typography.Text strong>Offsetting Successful!</Typography.Text>
          {routeReturnInfo?.receivedToken &&
            (routeReturnInfo?.receivedToken.address === constants.AddressZero ? (
              <span>{infoMessage}</span>
            ) : (
              <Tooltip title="Click to add this token to your wallet.">
                <span
                  style={{ cursor: 'copy' }}
                  onClick={() =>
                    switchChainAndAddToken(
                      routeReturnInfo.toChain.id,
                      routeReturnInfo.receivedToken!,
                    )
                  }>
                  {infoMessage}
                </span>
              </Tooltip>
            ))}
        </Space>
      )
    }

    // FAILED
    const isFailed =
      localRoute.lifiRoute.steps.some((step) => step.execution?.status === 'FAILED') ||
      etherspotStepExecution?.status === 'FAILED'
    if (isFailed) {
      return (
        <Button type="primary" onClick={() => restartCrossChainSwap()} style={{ marginTop: 10 }}>
          Restart from Failed Step
        </Button>
      )
    }

    const chainSwitchRequired = localRoute.lifiRoute.steps.some(
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
    for (const step of localRoute.lifiRoute.steps) {
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

  const parseEtherspotExecution = () => {
    if (!etherspotStepExecution) {
      return []
    }
    return etherspotStepExecution.process.map((process, index, processList) => {
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
                {renderProcessError(process)}
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
  const parseEtherspotStep = () => {
    const lastLiFiStep = localRoute.lifiRoute.steps[localRoute.lifiRoute.steps.length - 1]
    const index = localRoute.lifiRoute.steps.length
    const isDone = etherspotStepExecution && etherspotStepExecution.status === 'DONE'
    const isLoading =
      isSwapping && etherspotStepExecution && etherspotStepExecution.status === 'PENDING'
    const isPaused =
      !isSwapping && etherspotStepExecution && etherspotStepExecution.status === 'PENDING'
    const color = isDone ? 'green' : etherspotStepExecution ? 'blue' : 'gray'
    // const executionDuration = !!step.estimate.executionDuration && (
    //   <>
    //     <br />
    //     <span>Estimated duration: {parseSecondsAsTime(step.estimate.executionDuration)} min</span>
    //   </>
    // )
    return [
      <Timeline.Item position={isMobile ? 'right' : 'right'} key={index + '_left'} color={color}>
        <h4>Offset Carbon With BCT</h4>
        <span>
          {formatTokenAmount(lastLiFiStep.action.toToken, lastLiFiStep.estimate?.toAmount)}{' '}
          <ArrowRightOutlined />{' '}
          {formatTokenAmount(TOUCAN_BCT_TOKEN, localRoute.stakingStep.estimate?.toAmount)}
        </span>
        {/* {executionDuration} */}
      </Timeline.Item>,
      <Timeline.Item
        position={isMobile ? 'right' : 'left'}
        key={index + '_right'}
        color={color}
        dot={isLoading ? <LoadingOutlined /> : isPaused ? <PauseCircleOutlined /> : null}>
        {parseEtherspotExecution()}
      </Timeline.Item>,
    ]
  }

  return (
    <>
      {alerts}
      <br />

      <Timeline mode={isMobile ? 'left' : 'alternate'} className="swapping-modal-timeline">
        {/* Steps */}
        {localRoute.lifiRoute.steps.map(parseStepToTimeline)}
        {parseEtherspotStep()}
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
              <EditOutlined style={{ fontSize: 40 }} />
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
        <Modal
          className="accept-step-update-modal"
          visible={showAcceptSlippageUpdateModal.show}
          onOk={() => {
            if (showAcceptSlippageUpdateModal.promiseResolver) {
              showAcceptSlippageUpdateModal.promiseResolver(true)
            }
            setShowAcceptSlippageUpdateModal({
              show: false,
            })
          }}
          onCancel={() => {
            if (showAcceptSlippageUpdateModal.promiseResolver) {
              showAcceptSlippageUpdateModal.promiseResolver(false)
            }
            setShowAcceptSlippageUpdateModal({
              show: false,
            })
          }}>
          <Typography.Title level={4} style={{ marginBottom: 32 }}>
            Warning
          </Typography.Title>
          <Typography.Paragraph>
            The conditions of your transaction have changed. Do you accept the recalculated
            estimates? If you refuse, this transaction will not proceed and no funds will be sent.
          </Typography.Paragraph>
          <Typography.Paragraph>
            old return amount:{' '}
            {showAcceptSlippageUpdateModal.toToken &&
              showAcceptSlippageUpdateModal.oldToAmount &&
              formatTokenAmount(
                showAcceptSlippageUpdateModal.toToken!,
                showAcceptSlippageUpdateModal.oldToAmount!,
              )}{' '}
            <br />
            new return amount:{' '}
            {showAcceptSlippageUpdateModal.toToken &&
              showAcceptSlippageUpdateModal.newToAmount &&
              formatTokenAmount(
                showAcceptSlippageUpdateModal.toToken!,
                showAcceptSlippageUpdateModal.newToAmount!,
              )}
          </Typography.Paragraph>

          <Typography.Paragraph>
            old slippage: {showAcceptSlippageUpdateModal.oldSlippage! * 100 || '~'} % <br />
            new slippage: {showAcceptSlippageUpdateModal.newSlippage! * 100 || '~'} %
          </Typography.Paragraph>
        </Modal>
      </div>
    </>
  )
}

export default SwappingCarbonOffset
