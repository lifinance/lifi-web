import { EditOutlined } from '@ant-design/icons'
import { Web3Provider } from '@ethersproject/providers'
import {
  AcceptSlippageUpdateHookParams,
  ChainId,
  Execution,
  ExecutionSettings,
  Process,
  Token,
} from '@lifi/sdk'
import { useWeb3React } from '@web3-react/core'
import { Button, Divider, Modal, Row, Space, Spin, Timeline, Tooltip, Typography } from 'antd'
import { constants } from 'ethers'
import { Sdk } from 'etherspot'
import { useEffect, useState } from 'react'

import { sKLIMA_ADDRESS } from '../../constants'
import { useKlimaStakingExecutor } from '../../hooks/Etherspot/klimaStakingExecutor'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useStepReturnInfo } from '../../hooks/useStepReturnInfo'
import LiFi from '../../LiFi'
import { isWalletConnectWallet } from '../../services/localStorage'
import { switchChain, switchChainAndAddToken } from '../../services/metamask'
import Notification, { NotificationType } from '../../services/notifications'
import { renderProcessMessage } from '../../services/processRenderer'
import { ExtendedTransactionRequest } from '../../services/routingService'
import { formatTokenAmount } from '../../services/utils'
import { getChainById, isCrossStep, isLifiStep, Route, Step } from '../../types'
import Clock from '../Clock'
import LoadingIndicator from '../LoadingIndicator'
import { WalletConnectChainSwitchModal } from '../WalletConnectChainSwitchModal'
import { EtherspotStep } from './StepRenderers/EtherspotStep'
import { LIFIRouteSteps } from './StepRenderers/LIFIRouteSteps'
import { SimpleTransferStep } from './StepRenderers/SimpleTransferStep'

const SKLIMA_TOKEN_POL = {
  symbol: 'sKLIMA',
  decimals: 9,
  name: 'sKLIMA',
  chainId: 137,
  address: sKLIMA_ADDRESS,
}

interface SwapSettings {
  infiniteApproval: boolean
}

interface SwappingProps {
  route: {
    lifiRoute?: Route
    gasStep: Step
    stakingStep: Step
    simpleTransfer?: ExtendedTransactionRequest
  }
  etherspot?: Sdk
  settings: SwapSettings
  updateRoute: Function
  onSwapDone: Function
  fixedRecipient?: boolean
}

const SwappingEtherspotKlima = ({
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
  } = useKlimaStakingExecutor()

  const isMobile = useIsMobile()

  const [localRoute, setLocalRoute] = useState<{
    lifiRoute?: Route
    gasStep: Step
    stakingStep: Step
    simpleTransfer?: ExtendedTransactionRequest
  }>(route)

  const [swapStartedAt, setSwapStartedAt] = useState<number>()
  const [swapDoneAt, setSwapDoneAt] = useState<number>()
  const [isSwapping, setIsSwapping] = useState<boolean>(false)
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
  const [simpleTransferExecution, setSimpleTransferExecution] = useState<Execution>()
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
    if (localRoute.lifiRoute) {
      const { steps } = localRoute.lifiRoute
      // check if route is eligible for automatic resuming
      const allDone = steps.every((step) => step.execution?.status === 'DONE')
      const isFailed = steps.some((step) => step.execution?.status === 'FAILED')

      const alreadyStarted = steps.some((step) => step.execution)
      if (!allDone && !isFailed && alreadyStarted) {
        resumeLIFIRoute()
      }

      // move execution to background when modal is closed
      return function cleanup() {
        if (localRoute.lifiRoute) {
          LiFi.moveExecutionToBackground(localRoute.lifiRoute!)
        }
      }
    }
  }, [])

  const startExecution = async () => {
    if (localRoute.lifiRoute) {
      await startLIFIRoute()
    } else {
      await startSimpleTransfer()
    }
  }

  const startLIFIRoute = async () => {
    if (!web3.account || !web3.library || !localRoute.lifiRoute) return
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
          route.lifiRoute!.toAmountMin,
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

  const startSimpleTransfer = async () => {
    if (!web3.account || !web3.library || !localRoute.simpleTransfer) return
    setIsSwapping(true)
    setSwapStartedAt(Date.now())

    try {
      if (simpleTransferExecution?.status !== 'DONE') {
        await executeSimpleTransfer()
      }
      await finalizeEtherSpotStep(
        await executeEtherspotStep(
          etherspot!,
          route.gasStep,
          route.stakingStep,
          route.simpleTransfer!.amount,
        ),
      )
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Execution failed!', localRoute.simpleTransfer)
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
      !!transferExecutionError && handleSimpleTransferError(transferExecutionError)
      handlePotentialEtherSpotError(transferExecutionError, localRoute, simpleTransferExecution)
    }
    setTransferExecutionError(undefined)
  }, [transferExecutionError])

  const resumeLIFIRoute = async () => {
    if (!web3.account || !web3.library || !localRoute.lifiRoute) return

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
          route.lifiRoute!.toAmountMin,
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

  const restartExecution = async () => {
    // remove failed
    if (localRoute.lifiRoute) {
      const { steps } = localRoute.lifiRoute!
      for (let index = 0; index < steps.length; index++) {
        const stepHasFailed = steps[index].execution?.status === 'FAILED'
        // check if the step has been cancelled which is a "failed" state
        const stepHasBeenCancelled = steps[index].execution?.process.some(
          (process) => process.status === 'CANCELLED',
        )

        if (steps[index].execution && (stepHasFailed || stepHasBeenCancelled)) {
          steps[index].execution!.status = 'RESUME'
          steps[index].execution!.process.pop() // remove last (failed) process
          updateRoute(localRoute.lifiRoute)
        }
      }
      if (etherspotStepExecution) {
        resetEtherspotExecution()
      }
      // start again
      resumeLIFIRoute()
    }

    if (localRoute.simpleTransfer) {
      if (simpleTransferExecution && simpleTransferExecution.status === 'FAILED') {
        setSimpleTransferExecution(undefined)
      }
      if (etherspotStepExecution && etherspotStepExecution.status === 'FAILED') {
        resetEtherspotExecution()
      }
      startSimpleTransfer()
    }
  }

  const executeSimpleTransfer = async () => {
    const processList: Process[] = []
    if (!web3.library || !localRoute.simpleTransfer) return
    const signer = web3.library!.getSigner()
    if (localRoute.simpleTransfer.chainId !== (await signer.getChainId())) {
      processList.push({
        type: 'SWITCH_CHAIN',
        message: 'Switch Chain',
        startedAt: Date.now(),
        status: 'CHAIN_SWITCH_REQUIRED',
      })
      setSimpleTransferExecution({
        status: 'CHAIN_SWITCH_REQUIRED',
        process: processList,
      })

      await switchChain(localRoute.simpleTransfer.chainId!)
      const signer = web3.library!.getSigner()
      if ((await signer.getChainId()) !== localRoute.simpleTransfer.chainId) {
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
    processList.push({
      type: 'TRANSACTION',
      message: 'Sign Transaction',
      startedAt: Date.now(),
      status: 'ACTION_REQUIRED',
    })
    setSimpleTransferExecution({
      status: 'ACTION_REQUIRED',
      process: processList,
    })
    let tx

    tx = await signer.sendTransaction(localRoute.simpleTransfer.tx)

    processList.map((process) => {
      if (process.type === 'TRANSACTION') {
        process.status = 'DONE'
        process.doneAt = Date.now()
      }
      return process
    })
    const chain = getChainById(ChainId.POL)
    processList.push({
      type: 'RECEIVING_CHAIN',
      message: 'Wait For Transfer',
      startedAt: Date.now(),
      status: 'PENDING',
      txHash: tx.hash,
      txLink: chain.metamask.blockExplorerUrls[0] + 'tx/' + tx.hash,
    })
    setSimpleTransferExecution({
      status: 'PENDING',
      process: processList,
    })

    await tx.wait()

    processList.map((process) => {
      if (process.type === 'RECEIVING_CHAIN') {
        process.status = 'DONE'
        process.doneAt = Date.now()
      }
      return process
    })

    setSimpleTransferExecution({
      status: 'DONE',
      process: processList,
    })
  }

  const handleSimpleTransferError = (e: any) => {
    if (etherspotStepExecution || simpleTransferExecution?.status === 'DONE') return // We are already on the next step
    if (!simpleTransferExecution) {
      setSimpleTransferExecution({
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
      })
    } else {
      const processList = simpleTransferExecution.process
      processList[processList.length - 1].status = 'FAILED'
      processList[processList.length - 1].errorMessage = e.errorMessage
      processList[processList.length - 1].doneAt = Date.now()
      setSimpleTransferExecution({
        status: 'FAILED',
        process: processList,
      })
    }
  }

  const finalizeEtherSpotStep = async (stepExecution: Execution) => {
    const amountSKlimaParsed = localRoute.stakingStep.estimate.toAmountMin
    finalizeEtherSpotExecution(stepExecution!, amountSKlimaParsed)
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
    // const { steps } = localRoute.lifiRoute!
    let steps
    if (localRoute.lifiRoute) {
      steps = localRoute.lifiRoute.steps
    } else {
      steps = [{ execution: simpleTransferExecution, action: {} } as Step]
    }

    // PENDING
    if (isSwapping) {
      return <></>
    }
    const isCrossChainSwap = !!localRoute.lifiRoute?.steps.find(
      (step) => isCrossStep(step) || isLifiStep(step),
    )

    // DONE
    const isDone =
      steps.filter((step) => step.execution?.status !== 'DONE').length === 0 &&
      etherspotStepExecution?.status === 'DONE'
    if (isDone) {
      const infoMessage = !!routeReturnInfo?.totalBalanceOfReceivedToken ? (
        <>
          <Typography.Text>
            You received{` `}
            {formatTokenAmount(SKLIMA_TOKEN_POL, routeReturnInfo.receivedAmount.toString())}
          </Typography.Text>
          <Typography.Text
            type={!routeReturnInfo.receivedAmount.isZero() ? 'secondary' : undefined}
            style={{ fontSize: !routeReturnInfo.receivedAmount.isZero() ? 12 : 14 }}>
            <br />
            {`You now have ${routeReturnInfo.totalBalanceOfReceivedToken.amount} ${SKLIMA_TOKEN_POL.symbol}`}
            {` on ${routeReturnInfo.toChain.name}`}
          </Typography.Text>
        </>
      ) : (
        ''
      )

      return (
        <Space direction="vertical">
          <Typography.Text strong>Staking Successful!</Typography.Text>
          {routeReturnInfo &&
            (routeReturnInfo?.totalBalanceOfReceivedToken?.address === constants.AddressZero ? (
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
      steps.some((step) => step.execution?.status === 'FAILED') ||
      etherspotStepExecution?.status === 'FAILED'

    if (isFailed) {
      return (
        <Button type="primary" onClick={() => restartExecution()} style={{ marginTop: 10 }}>
          Restart from Failed Step
        </Button>
      )
    }

    const chainSwitchRequired =
      steps.some((step) => step.execution?.status === 'CHAIN_SWITCH_REQUIRED') ||
      etherspotStepExecution?.status === 'CHAIN_SWITCH_REQUIRED'
    if (chainSwitchRequired) {
      return <></>
    }

    // NOT_STARTED
    return (
      <Button type="primary" onClick={() => startExecution()} style={{ marginTop: 10 }}>
        {isCrossChainSwap ? 'Start Cross Chain Swap' : 'Start Swap'}
      </Button>
    )
  }

  const getCurrentProcess = () => {
    if (localRoute.lifiRoute) {
      const { steps } = localRoute.lifiRoute!
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
    } else {
      if (simpleTransferExecution) {
        for (const process of simpleTransferExecution.process) {
          if (process.status === 'ACTION_REQUIRED' || process.status === 'PENDING') {
            return process
          }
        }
      }
      if (etherspotStepExecution) {
        for (const process of etherspotStepExecution.process) {
          if (process.status === 'ACTION_REQUIRED' || process.status === 'PENDING') {
            return process
          }
        }
      }
    }
  }

  const currentProcess = getCurrentProcess()

  const getLastStepBeforeStakingStepInfo = () => {
    if (localRoute.lifiRoute) {
      const lastLIFIStep = localRoute.lifiRoute.steps[localRoute.lifiRoute.steps.length - 1]
      return {
        token: lastLIFIStep.action.toToken,
        amount: lastLIFIStep.estimate.toAmountMin,
      }
    } else {
      return {
        token: localRoute.simpleTransfer?.token,
        amount: localRoute.simpleTransfer?.amount,
      }
    }
  }

  return (
    <>
      <Timeline mode={isMobile ? 'left' : 'alternate'} className="swapping-modal-timeline">
        {/* Steps */}
        {!!localRoute.simpleTransfer &&
          !localRoute.lifiRoute &&
          SimpleTransferStep({
            simpleTransfer: localRoute.simpleTransfer,
            simpleStepExecution: simpleTransferExecution,
            isSwapping: isSwapping,
            simpleTransferDestination: etherspot?.state.accountAddress!,
            isMobile,
          })}
        {!!localRoute.lifiRoute &&
          !localRoute.simpleTransfer &&
          LIFIRouteSteps({
            lifiRoute: localRoute.lifiRoute!,
            isSwapping: isSwapping,
            isMobile,
          })}
        {!!localRoute.stakingStep &&
          EtherspotStep({
            index: localRoute.simpleTransfer ? 1 : localRoute.lifiRoute?.steps.length || 100,
            previousStepInfo: getLastStepBeforeStakingStepInfo(),
            etherspotStepExecution: etherspotStepExecution,
            stakingStep: localRoute.stakingStep,
            isSwapping,
            isMobile,
          })}
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

export default SwappingEtherspotKlima
