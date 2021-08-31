import { CheckOutlined, DownOutlined, LinkOutlined, LoginOutlined, SwapOutlined, SyncOutlined } from '@ant-design/icons';
import { HistoricalTransaction, NxtpSdk, NxtpSdkEvent, NxtpSdkEvents } from '@connext/nxtp-sdk';
import { AuctionResponse, TransactionPreparedEvent } from '@connext/nxtp-utils';
import { Web3Provider } from '@ethersproject/providers';
import { useWeb3React } from '@web3-react/core';
import { Badge, Button, Checkbox, Col, Collapse, Dropdown, Form, Input, Menu, Modal, Row } from 'antd';
import { Content } from 'antd/lib/layout/layout';
import Title from 'antd/lib/typography/Title';
import BigNumber from 'bignumber.js';
import { providers } from 'ethers';
import { createBrowserHistory } from 'history';
import QueryString from 'qs';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import onehiveWordmark from '../../assets/1hive_wordmark.svg';
import connextWordmark from '../../assets/connext_wordmark.png';
import lifiWordmark from '../../assets/lifi_wordmark.svg';
import xpollinateWordmark from '../../assets/xpollinate_wordmark.svg';
import { clearLocalStorage } from '../../services/localStorage';
import { switchChain } from '../../services/metamask';
import { finishTransfer, getTransferQuote, setup, triggerTransfer } from '../../services/nxtp';
import { deepClone, formatTokenAmountOnly } from '../../services/utils';
import { ChainKey, ChainPortfolio, Token, TokenWithAmounts } from '../../types';
import { Chain, getChainById, getChainByKey } from '../../types/lists';
import { CrossAction, CrossEstimate, Execution, TranferStep } from '../../types/server';
import '../Swap.css';
import SwapForm from '../SwapForm';
import { getRpcProviders, injected } from '../web3/connectors';
import HistoricTransactionsTableNxtp from './HistoricTransactionsTableNxtp';
import SwappingNxtp from './SwappingNxtp';
import './SwapXpollinate.css';
import TestBalanceOverview from './TestBalanceOverview';
import TransactionsTableNxtp from './TransactionsTableNxtp';
import { ActiveTransaction, CrosschainTransaction } from './typesNxtp';

const history = createBrowserHistory()

const BALANCES_REFRESH_INTERVAL = 30000

const getDefaultParams = (search: string, transferChains: Chain[], transferTokens: { [ChainKey: string]: Array<Token> }) => {
  const defaultParams = {
    depositChain: transferChains[0].key,
    depositToken: transferTokens[transferChains[0].key][0].id,
    depositAmount: 1,
    withdrawChain: transferChains[1].key,
    withdrawToken: transferTokens[transferChains[1].key][0].id,
  }

  const params = QueryString.parse(search, { ignoreQueryPrefix: true })

  // fromChain + old: senderChainId
  if ((params.fromChain && typeof params.fromChain === 'string') || (params.senderChainId && typeof params.senderChainId === 'string')) {
    try {
      const newFromChainId = parseInt(typeof params.fromChain === 'string' ? params.fromChain : params.senderChainId as string)
      const newFromChain = transferChains.find((chain) => chain.id === newFromChainId)

      if (newFromChain) {
        if (newFromChain.key === defaultParams.withdrawChain) {
          // switch with withdraw chain
          defaultParams.withdrawChain = defaultParams.depositChain
          defaultParams.withdrawToken = defaultParams.depositToken
        }

        const foundTokenSymbol = transferTokens[defaultParams.depositChain].find(token => token.id === defaultParams.depositToken)!.symbol
        defaultParams.depositChain = newFromChain.key
        defaultParams.depositToken = transferTokens[newFromChain.key].find(token => token.symbol === foundTokenSymbol)!.id
      }
    } catch (e) { console.error(e) }
  }

  // fromToken
  if (params.fromToken && typeof params.fromToken === 'string') {
    // does token exist?
    const foundToken = transferTokens[defaultParams.depositChain].find(token => token.id === params.fromToken)
    if (foundToken) {
      defaultParams.depositToken = foundToken.id
      defaultParams.withdrawToken = transferTokens[defaultParams.withdrawChain].find(token => token.symbol === foundToken.symbol)!.id
    }
  }

  // fromAmount
  if (params.fromAmount && typeof params.fromAmount === 'string') {
    try {
      const newAmount = parseFloat(params.fromAmount)
      if (newAmount > 0) {
        defaultParams.depositAmount = parseFloat(params.fromAmount)
      }
    } catch (e) { console.error(e) }
  }

  // toChain + old: receiverChainId
  if ((params.toChain && typeof params.toChain === 'string') || (params.receiverChainId && typeof params.receiverChainId === 'string')) {
    try {
      const newToChainId = parseInt(typeof params.toChain === 'string' ? params.toChain : params.receiverChainId as string)
      const newToChain = transferChains.find((chain) => chain.id === newToChainId)

      if (newToChain && newToChain.key !== defaultParams.depositChain) {
        // only set if different chain
        const foundTokenSymbol = transferTokens[defaultParams.depositChain].find(token => token.id === defaultParams.depositToken)!.symbol
        defaultParams.withdrawChain = newToChain.key
        defaultParams.withdrawToken = transferTokens[newToChain.key].find(token => token.symbol === foundTokenSymbol)!.id
      }
    } catch (e) { console.error(e) }
  }

  // toToken
  if (params.toToken && typeof params.toToken === 'string') {
    // does token exist?
    const foundToken = transferTokens[defaultParams.withdrawChain].find(token => token.id === params.toToken)
    if (foundToken) {
      defaultParams.withdrawToken = foundToken.id
      defaultParams.depositToken = transferTokens[defaultParams.depositChain].find(token => token.symbol === foundToken.symbol)!.id
    }
  }

  // old: assset
  if (params.asset && typeof params.asset === 'string') {
    const foundToken = transferTokens[defaultParams.depositChain].find(token => token.symbol === params.asset)
    if (foundToken) {
      defaultParams.depositToken = foundToken.id
      defaultParams.withdrawToken = transferTokens[defaultParams.withdrawChain].find(token => token.symbol === foundToken.symbol)!.id
    }
  }

  return defaultParams
}

function debounce(func: Function, timeout: number = 300) {
  let timer: NodeJS.Timeout
  return (...args: any) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      func(...args)
    }, timeout)
  }
}

let chainProviders: Record<number, providers.FallbackProvider>

let startParams: {
  depositChain: ChainKey;
  depositToken: string;
  depositAmount: number;
  withdrawChain: ChainKey;
  withdrawToken: string;
}

interface SwapXpollinateProps {
  alert: any
  transferChains: Chain[]
  transferTokens: { [ChainKey: string]: Array<Token> }
  getBalancesForWallet: Function
  testnet?: boolean
}

const SwapXpollinate = ({
  alert,
  transferChains,
  transferTokens,
  getBalancesForWallet,
  testnet,
}: SwapXpollinateProps) => {
  // INIT
  startParams = startParams ?? getDefaultParams(history.location.search, transferChains, transferTokens)
  chainProviders = chainProviders ?? getRpcProviders(transferChains.map(chain => chain.id))

  const [stateUpdate, setStateUpdate] = useState<number>(0)

  // Form
  const [depositChain, setDepositChain] = useState<ChainKey>(startParams.depositChain)
  const [depositAmount, setDepositAmount] = useState<number>(startParams.depositAmount)
  const [depositToken, setDepositToken] = useState<string>(startParams.depositToken)
  const [withdrawChain, setWithdrawChain] = useState<ChainKey>(startParams.withdrawChain)
  const [withdrawAmount, setWithdrawAmount] = useState<number>(Infinity)
  const [withdrawToken, setWithdrawToken] = useState<string>(startParams.withdrawToken)
  const [tokens, setTokens] = useState<{ [ChainKey: string]: Array<TokenWithAmounts> }>(transferTokens)
  const [refreshBalances, setRefreshBalances] = useState<number>(1)
  const [balances, setBalances] = useState<{ [ChainKey: string]: Array<ChainPortfolio> }>()
  const [updatingBalances, setUpdatingBalances] = useState<boolean>(false)

  // Advanced Options
  const [optionInfiniteApproval, setOptionInfiniteApproval] = useState<boolean>(true)
  const [optionReceivingAddress, setOptionReceivingAddress] = useState<string>('')
  const [optionContractAddress, setOptionContractAddress] = useState<string>('')
  const [optionCallData, setOptionCallData] = useState<string>('')

  // Routes
  const [routeUpdate, setRouteUpdate] = useState<number>(1)
  const [routeRequest, setRouteRequest] = useState<any>()
  const [routeQuote, setRouteQuote] = useState<AuctionResponse>()
  const [routesLoading, setRoutesLoading] = useState<boolean>(false)
  const [noRoutesAvailable, setNoRoutesAvailable] = useState<boolean>(false)
  const [routes, setRoutes] = useState<Array<Array<TranferStep>>>([])
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1)
  const [executionRoutes, setExecutionRoutes] = useState<Array<Array<TranferStep>>>([])
  const [modalRouteIndex, setModalRouteIndex] = useState<number>()

  // nxtp
  const [sdk, setSdk] = useState<NxtpSdk>()
  const [sdkChainId, setSdkChainId] = useState<number>()
  const [sdkAccount, setSdkAccount] = useState<string>()
  const [activeTransactions, setActiveTransactions] = useState<Array<ActiveTransaction>>([])
  const [updatingActiveTransactions, setUpdatingActiveTransactions] = useState<boolean>(false)
  const [historicTransaction, setHistoricTransactions] = useState<Array<HistoricalTransaction>>([])
  const [updateHistoricTransactions, setUpdateHistoricTransactions] = useState<boolean>(true)
  const [updatingHistoricTransactions, setUpdatingHistoricTransactions] = useState<boolean>(false)
  const [activeKeyTransactions, setActiveKeyTransactions] = useState<string>('')

  // Wallet
  const web3 = useWeb3React<Web3Provider>()
  const { activate, deactivate } = useWeb3React()
  const intervalRef = useRef<NodeJS.Timeout>()

  // update query string
  useEffect(() => {
    const params = {
      fromChain: getChainByKey(depositChain).id,
      fromToken: depositToken,
      toChain: getChainByKey(withdrawChain).id,
      toToken: withdrawToken,
      fromAmount: depositAmount,
    }
    const search = QueryString.stringify(params)
    history.push({
      search,
    });
  }, [depositChain, withdrawChain, depositToken, withdrawToken, depositAmount]);

  // auto-trigger finish if corresponding modal is opend
  useEffect(() => {
    // is modal open?
    if (modalRouteIndex !== undefined) {
      const crossEstimate = executionRoutes[modalRouteIndex][0].estimate! as CrossEstimate
      const transaction = activeTransactions.find((item) => item.txData.invariant.transactionId === crossEstimate.quote.bid.transactionId)
      if (transaction && transaction.status === NxtpSdkEvents.ReceiverTransactionPrepared) {
        const route = executionRoutes[modalRouteIndex]
        const update = (step: TranferStep, status: Execution) => {
          step.execution = status
          updateExecutionRoute(route)
        }

        finishTransfer(sdk!, transaction.event, route[0], update)
      }
    }
    // eslint-disable-next-line
  }, [modalRouteIndex, executionRoutes, sdk])

  // update table helpers
  const updateActiveTransactionsWith = (transactionId: string, status: NxtpSdkEvent, event: any, txData?: CrosschainTransaction) => {
    setActiveTransactions((activeTransactions) => {
      // update existing?
      let updated = false
      const updatedTransactions = activeTransactions.map((item) => {
        if (item.txData.invariant.transactionId === transactionId) {
          if (txData) {
            item.txData = Object.assign({}, item.txData, txData)
          }
          item.status = status
          item.event = event
          updated = true
        }
        return item
      })

      if (updated) {
        return updatedTransactions
      } else {
        return [
          ...activeTransactions,
          { txData: txData!, status, event },
        ]
      }
    })
  }

  const removeActiveTransaction = (transactionId: string) => {
    setActiveTransactions((activeTransactions) => {
      return activeTransactions.filter((t) => t.txData.invariant.transactionId !== transactionId)
    })
  }

  useEffect(() => {
    const initializeConnext = async () => {
      if (sdk && sdkChainId === web3.chainId && sdkAccount === web3.account) {
        return sdk
      }
      if (!web3.library || !web3.account) {
        throw Error('Connect Wallet first.')
      }

      const signer = web3.library.getSigner()
      setSdkChainId(web3.chainId)
      setSdkAccount(web3.account)

      if (sdk) {
        sdk.removeAllListeners()
      }

      const _sdk = await setup(signer, chainProviders)
      setSdk(_sdk)

      // listen to events
      _sdk.attach(NxtpSdkEvents.SenderTransactionPrepared, (data) => {
        updateActiveTransactionsWith(data.txData.transactionId, NxtpSdkEvents.SenderTransactionPrepared, data, { invariant: data.txData, sending: data.txData })
        setRefreshBalances(state => state + 1)
      })

      _sdk.attach(NxtpSdkEvents.SenderTransactionFulfilled, async (data) => {
        updateActiveTransactionsWith(data.txData.transactionId, NxtpSdkEvents.SenderTransactionFulfilled, data, { invariant: data.txData, sending: data.txData })
        removeActiveTransaction(data.txData.transactionId)
        setRefreshBalances(state => state + 1)
        setUpdateHistoricTransactions(true)
      })

      _sdk.attach(NxtpSdkEvents.SenderTransactionCancelled, async (data) => {
        updateActiveTransactionsWith(data.txData.transactionId, NxtpSdkEvents.SenderTransactionCancelled, data, { invariant: data.txData, sending: data.txData })
        removeActiveTransaction(data.txData.transactionId)
        setUpdateHistoricTransactions(true)
      })

      _sdk.attach(NxtpSdkEvents.ReceiverPrepareSigned, (data) => {
        updateActiveTransactionsWith(data.transactionId, NxtpSdkEvents.ReceiverPrepareSigned, data)
        setActiveKeyTransactions('active')
      })

      _sdk.attach(NxtpSdkEvents.ReceiverTransactionPrepared, (data) => {
        updateActiveTransactionsWith(data.txData.transactionId, NxtpSdkEvents.ReceiverTransactionPrepared, data, { invariant: data.txData, receiving: data.txData })
      })

      _sdk.attach(NxtpSdkEvents.ReceiverTransactionFulfilled, async (data) => {
        updateActiveTransactionsWith(data.txData.transactionId, NxtpSdkEvents.ReceiverTransactionFulfilled, data, { invariant: data.txData, receiving: data.txData })
        removeActiveTransaction(data.txData.transactionId)
        setRefreshBalances(state => state + 1)
        setUpdateHistoricTransactions(true)
      })

      _sdk.attach(NxtpSdkEvents.ReceiverTransactionCancelled, async (data) => {
        updateActiveTransactionsWith(data.txData.transactionId, NxtpSdkEvents.ReceiverTransactionCancelled, data, { invariant: data.txData, receiving: data.txData })
        removeActiveTransaction(data.txData.transactionId)
        setUpdateHistoricTransactions(true)
      })

      // fetch historic transactions
      setUpdateHistoricTransactions(true)

      // get pending transactions
      setUpdatingActiveTransactions(true)
      const transactions = await _sdk.getActiveTransactions()
      for (const transaction of transactions) {
        // merge to txData to be able to pass event to fulfillTransfer
        (transaction as any).txData = {
          ...transaction.crosschainTx.invariant,
          ...(transaction.crosschainTx.receiving ??
            transaction.crosschainTx.sending),
        }
        updateActiveTransactionsWith(
          transaction.crosschainTx.invariant.transactionId,
          transaction.status,
          transaction,
          transaction.crosschainTx
        )
      }
      if (transactions.length) {
        setActiveKeyTransactions('active')
      }
      setUpdatingActiveTransactions(false)

      return _sdk
    }

    // init only once
    if (web3.library && web3.account && ((!sdk && !sdkChainId) || (sdk && sdkChainId))) {
      initializeConnext()
    }

    // deactivate
    if (!web3.account) {
      setHighlightedIndex(-1)
      setActiveTransactions([])
      setHistoricTransactions([])
      setExecutionRoutes([])
      setSdkChainId(undefined)
      if (sdk) {
        sdk.removeAllListeners()
        sdk.detach()
        setSdk(undefined)
      }
    }

  }, [web3, sdk, sdkChainId, sdkAccount])

  const getSelectedWithdraw = () => {
    if (highlightedIndex === -1) {
      return '...'
    } else {
      const selectedRoute = routes[highlightedIndex]
      const lastStep = selectedRoute[selectedRoute.length - 1]
      if (lastStep.action.type === 'withdraw') {
        return formatTokenAmountOnly(lastStep.action.token, lastStep.estimate?.toAmount)
      } else if (lastStep.action.type === '1inch' || lastStep.action.type === 'paraswap') {
        return formatTokenAmountOnly(lastStep.action.toToken, lastStep.estimate?.toAmount)
      } else if (lastStep.action.type === 'cross') {
        return formatTokenAmountOnly(lastStep.action.toToken, lastStep.estimate?.toAmount)
      } else {
        return '...'
      }
    }
  }

  const loadHistoricTransactions = useCallback(async () => {
    setUpdatingHistoricTransactions(true)
    setHistoricTransactions(await sdk!.getHistoricalTransactions())
    setUpdateHistoricTransactions(false)
    setUpdatingHistoricTransactions(false)
  }, [sdk])

  useEffect(() => {
    if (sdk && updateHistoricTransactions && !updatingHistoricTransactions) {
      loadHistoricTransactions()
    }
  }, [sdk, updateHistoricTransactions, updatingHistoricTransactions, loadHistoricTransactions])

  const updateBalances = useCallback(async (address: string) => {
    setUpdatingBalances(true)
    await getBalancesForWallet(address).then(setBalances)
    setUpdatingBalances(false)
  }, [getBalancesForWallet])

  useEffect(() => {
    if (refreshBalances && web3.account) {
      setRefreshBalances(state => 0)
      updateBalances(web3.account)
    }
  }, [refreshBalances, web3.account, updateBalances])

  useEffect(() => {
    if (!web3.account) {
      setBalances(undefined) // reset old balances
    } else {
      setRefreshBalances(state => state + 1)
    }
  }, [web3.account])


  const getBalance = (chainKey: ChainKey, tokenId: string) => {
    if (!balances) {
      return 0
    }

    const tokenBalance = balances[chainKey].find(portfolio => portfolio.id === tokenId)

    return tokenBalance?.amount || 0
  }

  useEffect(() => {
    // merge tokens and balances
    if (!balances) {
      for (const chain of transferChains) {
        for (const token of tokens[chain.key]) {
          token.amount = -1
          token.amountRendered = ''
        }
      }
    } else {
      for (const chain of transferChains) {
        for (const token of tokens[chain.key]) {
          token.amount = getBalance(chain.key, token.id)
          token.amountRendered = token.amount.toFixed(4)
        }
      }
    }

    setTokens(tokens)
    setStateUpdate(stateUpdate + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens, balances])

  useEffect(() => {
    intervalRef.current = setInterval(() => setRefreshBalances(state => state + 1), BALANCES_REFRESH_INTERVAL)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [])

  const hasSufficientBalance = () => {
    if (!depositToken) {
      return true
    }
    return depositAmount <= getBalance(depositChain, depositToken)
  }

  const findToken = useCallback((chainKey: ChainKey, tokenId: string) => {
    const token = tokens[chainKey].find(token => token.id === tokenId)
    if (!token) {
      throw new Error('Token not found')
    }
    return token
  }, [tokens])

  const doRequestAndBidMatch = (request: any, quote: AuctionResponse) => {
    if (
      getChainByKey(request.depositChain).id !== quote.bid.sendingChainId
      || request.depositToken !== quote.bid.sendingAssetId
      || getChainByKey(request.withdrawChain).id !== quote.bid.receivingChainId
      || request.withdrawToken !== quote.bid.receivingAssetId
      || request.depositAmount !== quote.bid.amount
      || request.receivingAddress !== quote.bid.receivingAddress
      // || request.callTo !== quote.bid.callTo
      // || request.callData !== quote.bid.callDataHash
    ) {
      return false
    }

    return true
  }

  // update request based on UI
  const defineRoute = (depositChain: ChainKey, depositToken: string, withdrawChain: ChainKey, withdrawToken: string, depositAmount: string, receivingAddress: string, callTo: string | undefined, callData: string | undefined) => {
    setRouteRequest({
      depositChain,
      depositToken,
      withdrawChain,
      withdrawToken,
      depositAmount,
      receivingAddress,
      callTo,
      callData,
    })
  }
  const debouncedSave = useRef(debounce(defineRoute, 500)).current
  const getTransferRoutes = useCallback(async () => {
    setRoutes([])
    setHighlightedIndex(-1)
    setNoRoutesAvailable(false)

    if (!sdk || !web3.account || !routeUpdate) {
      return
    }

    if ((isFinite(depositAmount) && depositAmount > 0) && depositChain && depositToken && withdrawChain && withdrawToken) {
      const receiving = optionReceivingAddress !== '' ? optionReceivingAddress : web3.account
      const callTo = optionContractAddress !== '' ? optionContractAddress : undefined
      const callData = optionCallData !== '' ? optionCallData : undefined
      const dToken = findToken(depositChain, depositToken)
      const dAmount = new BigNumber(depositAmount).shiftedBy(dToken.decimals)
      debouncedSave(depositChain, depositToken, withdrawChain, withdrawToken, dAmount.toFixed(), receiving, callTo, callData)
    }
  }, [
    depositAmount,
    depositChain,
    depositToken,
    withdrawChain,
    withdrawToken,
    web3,
    sdk,
    optionReceivingAddress,
    optionContractAddress,
    optionCallData,
    debouncedSave,
    findToken,
    routeUpdate,
  ])
  useEffect(() => {
    getTransferRoutes()
  }, [
    getTransferRoutes,
  ])

  // route generation if needed
  const generateRoutes = useCallback(async (sdk: NxtpSdk, depositChain: ChainKey, depositToken: string, withdrawChain: ChainKey, withdrawToken: string, depositAmount: string, receivingAddress: string, callTo: string | undefined, callData: string | undefined) => {
    setRoutesLoading(true)

    try {
      const quote = await getTransferQuote(
        sdk!,
        getChainByKey(depositChain).id,
        depositToken,
        getChainByKey(withdrawChain).id,
        withdrawToken,
        depositAmount,
        receivingAddress,
        callTo,
        callData,
      )

      if (!quote) {
        throw new Error('Empty Quote')
      }

      setRouteQuote(quote)

    } catch (e) {
      console.error(e)
      setNoRoutesAvailable(true)
      setRoutesLoading(false)
    }
  }, [])
  useEffect(() => {
    if (routeRequest && routeQuote && doRequestAndBidMatch(routeRequest, routeQuote)) {
      return // already calculated
    }

    if (sdk && routeRequest) {
      generateRoutes(
        sdk,
        routeRequest.depositChain,
        routeRequest.depositToken,
        routeRequest.withdrawChain,
        routeRequest.withdrawToken,
        routeRequest.depositAmount,
        routeRequest.receivingAddress,
        routeRequest.callTo,
        routeRequest.callData,
      )
    }
  }, [sdk, routeRequest, routeQuote, generateRoutes])

  // parse routeQuote if still it matches current request
  useEffect(() => {
    if (!routeRequest || !routeQuote) {
      return
    }
    if (!doRequestAndBidMatch(routeRequest, routeQuote)) {
      return
    }

    const dAmount = routeRequest.depositAmount
    const dToken = findToken(routeRequest.depositChain, routeRequest.depositToken)
    const wToken = findToken(routeRequest.withdrawChain, routeRequest.withdrawToken)
    const toAmount = parseInt(routeQuote.bid.amountReceived)
    const sortedRoutes: Array<Array<TranferStep>> = [[
      {
        action: {
          type: 'cross',
          method: 'nxtp',
          chainId: getChainByKey(routeRequest.depositChain).id,
          chainKey: routeRequest.depositChain,
          toChainKey: routeRequest.withdrawChain,
          amount: dAmount,
          fromToken: dToken,
          toToken: wToken,
        } as CrossAction,
        estimate: {
          fromAmount: dAmount,
          toAmount: toAmount,
          fees: {
            included: true,
            percentage: (dAmount - toAmount) / dAmount * 100,
            token: dToken,
            amount: dAmount - toAmount,
          },
          quote: routeQuote,
        } as CrossEstimate,
      }
    ]]

    setRoutes(sortedRoutes)
    setHighlightedIndex(sortedRoutes.length === 0 ? -1 : 0)
    setNoRoutesAvailable(sortedRoutes.length === 0)
    setRoutesLoading(false)
  }, [routeRequest, routeQuote, findToken])

  const updateExecutionRoute = (route: Array<TranferStep>) => {
    setExecutionRoutes(routes => {
      let index = routes.findIndex(item => {
        return item[0].id === route[0].id
      })
      const newRoutes = [
        ...routes.slice(0, index),
        route,
        ...routes.slice(index + 1)
      ]
      return newRoutes
    })
  }

  const openSwapModal = () => {
    // add execution route
    const route = deepClone(routes[highlightedIndex]) as Array<TranferStep>
    setExecutionRoutes(routes => [...routes, route])

    // get new route to avoid triggering the same quote twice
    setRouteQuote(undefined)

    // add as active
    const crossAction = route[0].action as CrossAction
    const crossEstimate = route[0].estimate as CrossEstimate
    const txData = {
      invariant: {
        user: '',
        router: '',
        sendingAssetId: crossAction.fromToken.id,
        receivingAssetId: crossAction.toToken.id,
        sendingChainFallback: '',
        callTo: '',
        receivingAddress: '',
        sendingChainId: crossAction.chainId,
        receivingChainId: getChainByKey(crossAction.toChainKey).id,
        callDataHash: '',
        transactionId: crossEstimate.quote.bid.transactionId,
        receivingChainTxManagerAddress: ''
      },
      sending: {
        amount: crossAction.amount.toString(),
        preparedBlockNumber: 0,
        expiry: Math.floor(Date.now() / 1000) + 3600 * 24 * 3, // 3 days
      },
    }
    updateActiveTransactionsWith(crossEstimate.quote.bid.transactionId, 'Started' as NxtpSdkEvent, {} as TransactionPreparedEvent, txData)
    setActiveKeyTransactions('active')

    // start execution
    const update = (step: TranferStep, status: Execution) => {
      step.execution = status
      updateExecutionRoute(route)
    }
    triggerTransfer(sdk!, route[0], update, optionInfiniteApproval)

    // open modal
    setModalRouteIndex(executionRoutes.length)
  }

  const openSwapModalFinish = (action: ActiveTransaction) => {
    // open modal
    const index = executionRoutes.findIndex(item => {
      return item[0].id === action.txData.invariant.transactionId
    })

    if (index !== -1) {
      setModalRouteIndex(index)

      // trigger sdk
      const route = executionRoutes[index]
      const update = (step: TranferStep, status: Execution) => {
        step.execution = status
        updateExecutionRoute(route)
      }
      finishTransfer(sdk!, action.event, route[0], update)
    } else {
      finishTransfer(sdk!, action.event)
    }
  }

  const submitButton = () => {
    if (!web3.account) {
      return <Button shape="round" type="primary" icon={<LoginOutlined />} size={"large"} htmlType="submit" onClick={() => activate(injected)}>Connect Wallet</Button>
    }
    if (web3.chainId !== getChainByKey(depositChain).id) {
      return <Button shape="round" type="primary" size={"large"} htmlType="submit" onClick={() => switchChain(getChainByKey(depositChain).id)}>Change Chain</Button>
    }
    if (routesLoading) {
      return <Button disabled={true} shape="round" type="primary" icon={<SyncOutlined spin />} size={"large"}>Searching Routes...</Button>
    }
    if (noRoutesAvailable) {
      return <Button shape="round" type="primary" size={"large"} className="grayed" onClick={() => { setRouteUpdate(routeUpdate + 1) }}>No Route Found (Retry)</Button>
    }
    if (!hasSufficientBalance()) {
      return <Button disabled={true} shape="round" type="primary" size={"large"}>Insufficient Funds</Button>
    }

    return <Button disabled={highlightedIndex === -1} shape="round" type="primary" icon={<SwapOutlined />} htmlType="submit" size={"large"} onClick={() => openSwapModal()}>Swap</Button>
  }

  const cancelTransfer = async (txData: CrosschainTransaction) => {
    try {
      await sdk?.cancel({ relayerFee: '0', signature: '0x', txData: { ...txData.invariant, ...txData.sending! } }, txData.invariant.sendingChainId)
      removeActiveTransaction(txData.invariant.transactionId)
    } catch (e) {
      console.error('Failed to cancel', e)
    }
  }

  const handleMenuClick = (e: any) => {
    switchChain(parseInt(e.key))
  }

  const currentChain = web3.chainId ? getChainById(web3.chainId) : undefined
  const isSupported = !!transferChains.find((chain) => chain.id === currentChain?.id)
  const menuChain = (
    <Menu onClick={handleMenuClick}>
      {transferChains.map((chain) => {
        return (
          <Menu.Item key={chain.id} icon={<LoginOutlined />} disabled={web3.chainId === chain.id}>
            {chain.name}
          </Menu.Item>
        )
      })}
    </Menu>
  )

  const menuAccount = (
    <Menu >
      <Menu.Item key="disconnect" onClick={() => disconnect()}>Disconnect</Menu.Item>
    </Menu>
  )

  const disconnect = () => {
    deactivate()
    clearLocalStorage()
  }

  return (
    <Content className="site-layout xpollinate" style={{ minHeight: 'calc(100vh)', marginTop: 0 }}>
      <div style={{ borderBottom: '1px solid #c6c6c6', marginBottom: 40 }}>
        <Row justify="space-between" style={{ padding: 20, maxWidth: 1600, margin: 'auto' }}>
          <a href="/">
            <img src={xpollinateWordmark} alt="xPollinate" style={{ width: '100%', maxWidth: '160px' }} />
            <span className="version">v2 {testnet && 'Testnet'}</span>
          </a>

          <span className="header-options">

            {web3.account ? (
              <>
                <Dropdown overlay={menuChain}>
                  <Button className="header-button">
                    <Badge color={isSupported ? 'green' : 'orange'} text={currentChain?.name || 'Unsupported Chain'} /> <DownOutlined />
                  </Button>
                </Dropdown>

                <Dropdown overlay={menuAccount}>
                  <Button className="header-button">
                    {web3.account.substr(0, 6)}...{web3.account.substr(-4, 4)}
                  </Button>
                </Dropdown>
              </>
            ) : (
              <Button shape="round" type="link" icon={<LoginOutlined />} onClick={() => activate(injected)}>Connect Wallet</Button>
            )}

            <a href="https://support.connext.network/hc/en-us" target="_blank" rel="nofollow noreferrer" className="header-button support-link">
              <span>Support <LinkOutlined /></span>
            </a>

          </span>
        </Row>
      </div>

      <div className="swap-view" style={{ minHeight: '900px', maxWidth: 1600, margin: 'auto' }}>

        {/* Infos */}
        <Row justify="center" style={{ padding: 20, paddingTop: 0 }}>
          {alert}
        </Row>

        <Collapse activeKey={activeKeyTransactions} accordion ghost>

          {/* Balances */}
          {testnet &&
            <Collapse.Panel className={balances ? '' : 'empty'} header={(
              <h2
                onClick={() => setActiveKeyTransactions((key) => key === 'balances' ? '' : 'balances')}
                style={{ display: 'inline' }}
              >
                Balances ({updatingBalances ? <SyncOutlined spin /> : (!balances ? '-' : <CheckOutlined />)})
              </h2>
            )} key="balances">
              <div style={{ overflowX: 'scroll', background: 'white', margin: '10px 20px' }}>
                <TestBalanceOverview
                  transferChains={transferChains}
                  updateBalances={() => updateBalances(web3.account!)}
                  updatingBalances={updatingBalances}
                  balances={balances}
                />
              </div>
            </Collapse.Panel>
          }

          {/* Active Transactions */}
          <Collapse.Panel className={activeTransactions.length ? '' : 'empty'} header={(
            <h2
              onClick={() => setActiveKeyTransactions((key) => key === 'active' ? '' : 'active')}
              style={{ display: 'inline' }}
            >
              Active Transactions ({!sdk ? '-' : (updatingActiveTransactions ? <SyncOutlined spin /> : activeTransactions.length)})
            </h2>
          )} key="active">
            <div style={{ overflowX: 'scroll', background: 'white', margin: '10px 20px' }}>
              <TransactionsTableNxtp
                activeTransactions={activeTransactions}
                executionRoutes={executionRoutes}
                setModalRouteIndex={setModalRouteIndex}
                openSwapModalFinish={openSwapModalFinish}
                switchChain={switchChain}
                cancelTransfer={cancelTransfer}
                tokens={tokens}
              />
            </div>
          </Collapse.Panel>

          {/* Historical Transactions */}
          <Collapse.Panel className={historicTransaction.length ? '' : 'empty'} header={(
            <h2
              onClick={() => setActiveKeyTransactions((key) => key === 'historic' ? '' : 'historic')}
              style={{ display: 'inline' }}
            >
              Historical Transactions ({!sdk ? '-' : (updatingHistoricTransactions ? <SyncOutlined spin /> : historicTransaction.length)})
            </h2>
          )} key="historic">
            <div style={{ overflowX: 'scroll', background: 'white', margin: '10px 20px' }}>
              <HistoricTransactionsTableNxtp
                historicTransactions={historicTransaction}
                tokens={tokens}
              />
            </div>
          </Collapse.Panel>
        </Collapse>

        {/* Swap Form */}
        <Row style={{ margin: 20 }} justify={"center"}>
          <Col className="swap-form">
            <div className="swap-input" style={{ maxWidth: 450, borderRadius: 6, padding: 24, margin: "0 auto" }}>
              <Row>
                <Title className="swap-title" level={4}>Please Specify Your Transaction</Title>
              </Row>

              <Form>
                <SwapForm
                  depositChain={depositChain}
                  setDepositChain={setDepositChain}
                  depositToken={depositToken}
                  setDepositToken={setDepositToken}
                  depositAmount={depositAmount}
                  setDepositAmount={setDepositAmount}

                  withdrawChain={withdrawChain}
                  setWithdrawChain={setWithdrawChain}
                  withdrawToken={withdrawToken}
                  setWithdrawToken={setWithdrawToken}
                  withdrawAmount={withdrawAmount}
                  setWithdrawAmount={setWithdrawAmount}
                  estimatedWithdrawAmount={getSelectedWithdraw()}

                  transferChains={transferChains}
                  tokens={tokens}
                  balances={balances}
                  forceSameToken={true}
                />

                <Row style={{ marginTop: 24 }} justify={"center"}>
                  {submitButton()}
                </Row>
              </Form>

              {/* Advanced Options */}
              <Row justify={"center"} >
                <Collapse ghost>
                  <Collapse.Panel header={`Advanced Options`} key="1">
                    Infinite Approval
                    <div>
                      <Checkbox
                        checked={optionInfiniteApproval}
                        onChange={(e) => setOptionInfiniteApproval(e.target.checked)}
                      >
                        Activate Infinite Approval
                      </Checkbox>
                    </div>

                    Receiving Address
                    <Input
                      value={optionReceivingAddress}
                      onChange={(e) => setOptionReceivingAddress(e.target.value)}
                      pattern="^0x[a-fA-F0-9]{40}$"
                      placeholder="Only when other than your sending wallet"
                      style={{ border: '1px solid rgba(0,0,0,0.25)', borderRadius: 6 }}
                    />

                    Contract Address
                    <Input
                      value={optionContractAddress}
                      onChange={(e) => setOptionContractAddress(e.target.value)}
                      pattern="^0x[a-fA-F0-9]{40}$"
                      placeholder="To call a contract"
                      style={{ border: '1px solid rgba(0,0,0,0.25)', borderRadius: 6 }}
                    />

                    CallData
                    <Input
                      value={optionCallData}
                      onChange={(e) => setOptionCallData(e.target.value)}
                      pattern="^0x[a-fA-F0-9]{64}$"
                      placeholder="Only when calling a contract directly"
                      style={{ border: '1px solid rgba(0,0,0,0.25)', borderRadius: 6 }}
                    />
                  </Collapse.Panel>
                </Collapse>
              </Row>

            </div>
          </Col>
        </Row>

        {/* Footer */}
        <Row justify="center" style={{ marginTop: 48, marginBottom: 8 }}>
          <Col>
            Powered by
          </Col>
        </Row>
        <Row justify="center" align="middle" style={{ marginBottom: 24 }}>
          <Col span={6} style={{ textAlign: 'right' }}>
            <a href="https://connext.network/" target="_blank" rel="nofollow noreferrer">
              <img src={connextWordmark} alt="Connext" style={{ width: '100%', maxWidth: '200px' }} />
            </a>
          </Col>
          <Col span={1} style={{ textAlign: 'center' }}>
            x
          </Col>
          <Col span={6} style={{ textAlign: 'center' }}>
            <a href="https://li.finance/" target="_blank" rel="nofollow noreferrer">
              <img src={lifiWordmark} alt="Li.Finance" style={{ width: '100%', maxWidth: '200px' }} />
            </a>
          </Col>
          <Col span={1} style={{ textAlign: 'center' }}>
            x
          </Col>
          <Col span={6} style={{ textAlign: 'left' }}>
            <a href="https://about.1hive.org/" target="_blank" rel="nofollow noreferrer">
              <img src={onehiveWordmark} alt="1hive" style={{ width: '80%', maxWidth: '160px' }} />
            </a>
          </Col>
        </Row>

      </div>

      {modalRouteIndex !== undefined
        ? <Modal
          className="swapModal"
          visible={true}
          onOk={() => setModalRouteIndex(undefined)}
          onCancel={() => setModalRouteIndex(undefined)}
          width={700}
          footer={null}
        >
          <SwappingNxtp route={executionRoutes[modalRouteIndex]}></SwappingNxtp>
        </Modal>
        : ''
      }
    </Content>
  )
}

export default SwapXpollinate