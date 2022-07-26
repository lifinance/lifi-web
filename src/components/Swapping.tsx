import {
  ArrowRightOutlined,
  EditOutlined,
  LoadingOutlined,
  PauseCircleOutlined,
} from '@ant-design/icons'
import { Web3Provider } from '@ethersproject/providers'
import { AcceptSlippageUpdateHookParams, ExecutionSettings, StatusMessage, Token } from '@lifi/sdk'
import { useWeb3React } from '@web3-react/core'
import { Button, Divider, Modal, Row, Space, Timeline, Tooltip, Typography } from 'antd'
import { constants } from 'ethers'
import { useEffect, useState } from 'react'

import { useStepReturnInfo } from '../hooks/useStepReturnInfo'
import LiFi from '../LiFi'
import {
  isWalletConnectWallet,
  readForegroundRoute,
  storeForegroundRoute,
  storeRoute,
} from '../services/localStorage'
import { switchChain, switchChainAndAddToken } from '../services/metamask'
import Notification, { NotificationType } from '../services/notifications'
import {
  renderProcessError,
  renderProcessMessage,
  renderSubstatusmessage,
} from '../services/processRenderer'
import { copyToClipboard, formatTokenAmount, parseSecondsAsTime } from '../services/utils'
import { getChainById, isCrossStep, isLifiStep, Route, Step } from '../types'
import { getChainAvatar, getToolAvatar } from './Avatars/Avatars'
import Clock from './Clock'
import LoadingIndicator from './LoadingIndicator'
import { FurtherLinks } from './SwappingMainButtonFiles/FurtherLinks'
import { SwappingModalInfoMessages } from './SwappingModalInfoMessages'
import { WalletConnectChainSwitchModal } from './WalletConnectChainSwitchModal'

interface SwapSettings {
  infiniteApproval: boolean
}

interface SwappingProps {
  route: Route
  settings: SwapSettings
  updateRoute: Function
  onSwapDone: Function
  fixedRecipient?: boolean
}

const Swapping = ({
  route,
  updateRoute,
  settings,
  onSwapDone,
  fixedRecipient = false,
}: SwappingProps) => {
  const [localRoute, setLocalRoute] = useState<Route>(route)
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

  const routeReturnInfo = useStepReturnInfo(localRoute.steps[localRoute.steps.length - 1])

  // Wallet
  const web3 = useWeb3React<Web3Provider>()

  useEffect(() => {
    setLocalRoute(route)
  }, [route])

  useEffect(() => {
    // check if route is eligible for automatic resuming
    const foregroundRouteID = readForegroundRoute()

    if (!foregroundRouteID) {
      const allDone = localRoute.steps.every((step) => step.execution?.status === 'DONE')
      const isFailed = localRoute.steps.some((step) => step.execution?.status === 'FAILED')

      const alreadyStarted = localRoute.steps.some((step) => step.execution)
      if (!allDone && !isFailed && alreadyStarted) {
        resumeExecution()
      }
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
              <>
                <Typography.Text type="secondary" style={{ whiteSpace: 'pre-wrap' }}>
                  {renderProcessError(process)}
                </Typography.Text>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'start',
                  }}>
                  <Button
                    style={{ margin: 0, padding: 0, cursor: 'copy' }}
                    type="link"
                    onClick={async () =>
                      copyToClipboard(
                        `${process.error?.message}\n${process.error?.htmlMessage?.replaceAll(
                          /(<([^>]+)>)/gi,
                          '\n',
                        )}`,
                      )
                    }>
                    Copy Error Message
                  </Button>
                  {!!step.execution?.process.some((process) => process.txHash) && (
                    <Button
                      type="link"
                      style={{ cursor: 'copy' }}
                      onClick={async () => {
                        const hashes = step.execution?.process
                          .filter((process) => process.txHash)
                          .map((process) => process.txHash)
                        copyToClipboard((!!hashes && hashes[hashes?.length - 1]) || '')
                      }}>
                      Copy TX hash
                    </Button>
                  )}
                </div>
              </>
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
        // position={isMobile ? 'right' : 'left'}
        position="right"
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
            // position={isMobile ? 'right' : 'right'}
            position="right"
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
          !!step.execution || localRoute.steps.length - 1 === index ? executionItem : <></>,
        ]
      }

      case 'cross': {
        const { action, estimate } = step
        return [
          <Timeline.Item
            // position={isMobile ? 'right' : 'right'}
            position="right"
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
          !!step.execution || localRoute.steps.length - 1 === index ? executionItem : <></>,
        ]
      }

      case 'lifi': {
        return [
          <Timeline.Item
            // position={isMobile ? 'right' : 'right'}
            position="right"
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
          !!step.execution || localRoute.steps.length - 1 === index ? executionItem : <></>,
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
    storeRoute(localRoute)
    storeForegroundRoute(localRoute)
    setIsSwapping(true)
    setSwapStartedAt(Date.now())
    try {
      await LiFi.executeRoute(signer, localRoute, executionSettings)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Execution failed!', localRoute)
      // eslint-disable-next-line no-console
      console.error(e)
      Notification.showNotification(NotificationType.TRANSACTION_ERROR)
      setIsSwapping(false)
      return
    }
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
      acceptSlippageUpdateHook,
      infiniteApproval: settings.infiniteApproval,
    }

    setIsSwapping(true)
    storeForegroundRoute(localRoute)
    try {
      await LiFi.resumeRoute(web3.library.getSigner(), localRoute, executionSettings)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Execution failed!', localRoute)
      // eslint-disable-next-line no-console
      console.error(e)
      Notification.showNotification(NotificationType.TRANSACTION_ERROR)
      setIsSwapping(false)
      return
    }
    setIsSwapping(false)
    setSwapDoneAt(Date.now())
    Notification.showNotification(NotificationType.TRANSACTION_SUCCESSFULL)
    onSwapDone()
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

  // called on every execution status change
  const updateCallback = (updatedRoute: Route) => {
    setLocalRoute(updatedRoute)
    storeRoute(updatedRoute)
    updateRoute(updatedRoute)
  }

  const getMainButton = () => {
    // PENDING
    if (isSwapping) {
      return <></>
    }
    const isCrossChainSwap = !!localRoute.steps.find(
      (step) => isCrossStep(step) || isLifiStep(step),
    )

    // DONE
    const isDone = localRoute.steps.filter((step) => step.execution?.status !== 'DONE').length === 0
    if (isDone) {
      const lastStepProcesses = localRoute.steps[localRoute.steps.length - 1].execution?.process
      const lastProcess = lastStepProcesses?.[lastStepProcesses?.length - 1]
      const infoMessage = !!routeReturnInfo?.totalBalanceOfReceivedToken ? (
        <>
          {!routeReturnInfo.receivedAmount.isZero() && fixedRecipient && (
            <>
              <Typography.Text>
                You sent{` `}
                {formatTokenAmount(
                  routeReturnInfo.receivedToken,
                  routeReturnInfo.receivedAmount.toString(),
                )}
              </Typography.Text>
              <br />
            </>
          )}
          {!routeReturnInfo.receivedAmount.isZero() && !fixedRecipient && (
            <>
              <Typography.Text
                type={!routeReturnInfo.receivedAmount.isZero() ? 'secondary' : undefined}
                style={{ fontSize: !routeReturnInfo.receivedAmount.isZero() ? 12 : 14 }}>
                {`You received ${routeReturnInfo.totalBalanceOfReceivedToken.amount} ${routeReturnInfo.totalBalanceOfReceivedToken.symbol}`}
                {` on ${routeReturnInfo.toChain.name}`}
              </Typography.Text>
            </>
          )}
        </>
      ) : (
        ''
      )
      const substatusmessage = lastProcess
        ? renderSubstatusmessage(lastProcess.status as StatusMessage, lastProcess?.substatus)
        : undefined

      const infoTitle = (
        <>
          <Row justify="center">
            <Typography.Text strong>
              Done
              {substatusmessage && `  - ${substatusmessage}`}
            </Typography.Text>
          </Row>
        </>
      )

      return (
        <Space direction="vertical">
          {infoTitle}
          {routeReturnInfo?.totalBalanceOfReceivedToken &&
            (routeReturnInfo.totalBalanceOfReceivedToken.address === constants.AddressZero ? (
              <span>{infoMessage}</span>
            ) : (
              <Tooltip title="Click to add this token to your wallet.">
                <span
                  style={{ cursor: 'copy' }}
                  onClick={() =>
                    switchChainAndAddToken(
                      routeReturnInfo.toChain.id,
                      routeReturnInfo.totalBalanceOfReceivedToken!,
                    )
                  }>
                  {infoMessage}
                </span>
              </Tooltip>
            ))}
          <FurtherLinks
            fixedRecipient={fixedRecipient}
            routeReturnInfo={routeReturnInfo}
            localRoute={localRoute}
          />
        </Space>
      )
    }

    // FAILED
    const isFailed = localRoute.steps.some((step) => step.execution?.status === 'FAILED')
    if (isFailed) {
      return (
        <Button type="primary" onClick={() => resumeExecution()} style={{ marginTop: 10 }}>
          Restart from Failed Step
        </Button>
      )
    }

    const chainSwitchRequired = localRoute.steps.some(
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
    for (const step of localRoute.steps) {
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

  const getCurrentStep = () => {
    for (const step of localRoute.steps) {
      if (step.execution && step.execution.status !== 'DONE') {
        return step
      }
    }
    return null
  }

  const currentProcess = getCurrentProcess()
  const currentStep = getCurrentStep()

  return (
    <>
      {alerts}
      <br />
      <Timeline
        // mode={isMobile ? 'left' : 'alternate'}
        mode="left"
        className="swapping-modal-timeline">
        {/* Steps */}
        {localRoute.steps.map(parseStepToTimeline)}
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

      <SwappingModalInfoMessages process={currentProcess} tool={currentStep?.tool} />

      <Divider />

      <div className="swapp-modal-footer">
        <div style={{ transform: 'scale(1.3)' }}>{getMainButton()}</div>

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
            <Row style={{ margin: 8 }} justify="center">
              <LoadingIndicator size="small" />
            </Row>
            <Row justify="center">
              <Typography.Text style={{ color: 'grey', textAlign: 'center' }}>
                {renderSubstatusmessage(currentProcess.status, currentProcess.substatus)}
              </Typography.Text>
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

export default Swapping
