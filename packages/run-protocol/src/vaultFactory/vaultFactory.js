// @ts-check

import '@agoric/zoe/exported.js';
import '@agoric/zoe/src/contracts/exported.js';

// The vaultFactory owns a number of VaultManagers and a mint for RUN.
//
// addVaultType is a closely held method that adds a brand new collateral type.
// It specifies the initial exchange rate for that type. It depends on a
// separately specified AMM to provide the ability to liquidate loans that are
// in arrears. We could check that the AMM has sufficient liquidity, but for the
// moment leave that to those participating in the governance process for adding
// new collateral type to ascertain.

// This contract wants to be managed by a contractGovernor, but it isn't
// compatible with contractGovernor, since it has a separate paramManager for
// each Vault. This requires it to manually replicate the API of contractHelper
// to satisfy contractGovernor. It needs to return a creatorFacet with
// { getParamMgrRetriever, getInvitation, getLimitedCreatorFacet }.

import { E } from '@endo/eventual-send';
import '@agoric/governance/src/exported';

import { makeScalarMap } from '@agoric/store';
import {
  assertProposalShape,
  getAmountOut,
  getAmountIn,
} from '@agoric/zoe/src/contractSupport/index.js';
import { makeRatioFromAmounts } from '@agoric/zoe/src/contractSupport/ratio.js';
import { Far } from '@endo/marshal';
import { assertElectorateMatches } from '@agoric/governance';

import { AmountMath } from '@agoric/ertp';
import { makeVaultManager } from './vaultManager.js';
import { makeLiquidationStrategy } from './liquidateMinimum.js';
import { makeMakeCollectFeesInvitation } from '../collectFees.js';
import { makeVaultParamManager, makeElectorateParamManager } from './params.js';

const { details: X } = assert;

/**
 * @param {ZCF<GovernanceTerms<{}> & {
 *   ammPublicFacet: unknown,
 *   liquidationInstall: unknown,
 *   loanTimingParams: {ChargingPeriod: ParamRecord<'nat'>, RecordingPeriod: ParamRecord<'nat'>},
 *   timerService: TimerService,
 *   priceAuthority: ERef<PriceAuthority>}>} zcf
 * @param {{feeMintAccess: FeeMintAccess, initialPoserInvitation: Invitation}} privateArgs
 */
export const start = async (zcf, privateArgs) => {
  const {
    ammPublicFacet,
    priceAuthority,
    timerService,
    liquidationInstall,
    electionManager,
    governedParams: governedTerms,
    loanTimingParams,
  } = zcf.getTerms();

  /** @type {Promise<GovernorPublic>} */
  const governorPublic = E(zcf.getZoeService()).getPublicFacet(electionManager);

  const { feeMintAccess, initialPoserInvitation } = privateArgs;
  const debtMint = await zcf.registerFeeMint('RUN', feeMintAccess);
  const { issuer: debtIssuer, brand: debtBrand } = debtMint.getIssuerRecord();
  zcf.setTestJig(() => ({
    runIssuerRecord: debtMint.getIssuerRecord(),
  }));

  /** a powerful object; can modify the invitation */
  const electorateParamManager = await makeElectorateParamManager(
    zcf.getZoeService(),
    initialPoserInvitation,
  );

  assertElectorateMatches(electorateParamManager, governedTerms);

  /** For temporary staging of newly minted tokens */
  const { zcfSeat: mintSeat } = zcf.makeEmptySeatKit();
  const { zcfSeat: rewardPoolSeat } = zcf.makeEmptySeatKit();

  /**
   * We provide an easy way for the vaultManager to add rewards to
   * the rewardPoolSeat, without directly exposing the rewardPoolSeat to them.
   *
   * @type {MintAndReallocate}
   */
  const mintAndReallocate = (toMint, fee, seat, ...otherSeats) => {
    const kept = AmountMath.subtract(toMint, fee);
    debtMint.mintGains(harden({ RUN: toMint }), mintSeat);
    try {
      rewardPoolSeat.incrementBy(mintSeat.decrementBy(harden({ RUN: fee })));
      seat.incrementBy(mintSeat.decrementBy(harden({ RUN: kept })));
      zcf.reallocate(rewardPoolSeat, mintSeat, seat, ...otherSeats);
    } catch (e) {
      mintSeat.clear();
      rewardPoolSeat.clear();
      // Make best efforts to burn the newly minted tokens, for hygiene.
      // That only relies on the internal mint, so it cannot fail without
      // there being much larger problems. There's no risk of tokens being
      // stolen here because the staging for them was already cleared.
      debtMint.burnLosses(harden({ RUN: toMint }), mintSeat);
      throw e;
    } finally {
      assert(
        Object.values(mintSeat.getCurrentAllocation()).every(a =>
          AmountMath.isEmpty(a),
        ),
        X`Stage should be empty of RUN`,
      );
    }
    // TODO add aggregate debt tracking at the vaultFactory level #4482
    // totalDebt = AmountMath.add(totalDebt, toMint);
  };

  const burnDebt = (toBurn, seat) => {
    debtMint.burnLosses(harden({ RUN: toBurn }), seat);
  };

  /** @type {Store<Brand,VaultManager>} */
  const collateralTypes = makeScalarMap('brand');

  /** @type { Store<Brand, import('./params.js').VaultParamManager> } */
  const vaultParamManagers = makeScalarMap('brand');

  /** @type {AddVaultType} */
  const addVaultType = async (
    collateralIssuer,
    collateralKeyword,
    initialParamValues,
  ) => {
    await zcf.saveIssuer(collateralIssuer, collateralKeyword);
    const collateralBrand = zcf.getBrandForIssuer(collateralIssuer);
    // We create only one vault per collateralType.
    assert(
      !collateralTypes.has(collateralBrand),
      `Collateral brand ${collateralBrand} has already been added`,
    );

    /** a powerful object; can modify parameters */
    const vaultParamManager = makeVaultParamManager(initialParamValues);
    vaultParamManagers.init(collateralBrand, vaultParamManager);

    const zoe = zcf.getZoeService();
    const { creatorFacet: liquidationFacet } = await E(zoe).startInstance(
      liquidationInstall,
      harden({ RUN: debtIssuer, Collateral: collateralIssuer }),
      harden({ amm: ammPublicFacet }),
    );
    const liquidationStrategy = makeLiquidationStrategy(liquidationFacet);

    const startTimeStamp = await E(timerService).getCurrentTimestamp();

    const vm = makeVaultManager(
      zcf,
      debtMint,
      collateralBrand,
      priceAuthority,
      loanTimingParams,
      vaultParamManager.readonly(),
      mintAndReallocate,
      burnDebt,
      timerService,
      liquidationStrategy,
      startTimeStamp,
    );
    collateralTypes.init(collateralBrand, vm);
    return vm;
  };

  /** @param {ZCFSeat} seat */
  const makeVaultHook = async seat => {
    assertProposalShape(seat, {
      give: { Collateral: null },
      want: { RUN: null },
    });
    const {
      give: { Collateral: collateralAmount },
    } = seat.getProposal();
    const { brand: brandIn } = collateralAmount;
    assert(
      collateralTypes.has(brandIn),
      X`Not a supported collateral type ${brandIn}`,
    );
    /** @type {VaultManager} */
    const mgr = collateralTypes.get(brandIn);
    return mgr.makeVaultKit(seat);
  };

  /** Make a loan in the vaultManager based on the collateral type.
   *
   * @deprecated
   */
  const makeVaultInvitation = () => {
    return zcf.makeInvitation(makeVaultHook, 'MakeVault');
  };

  const getCollaterals = async () => {
    // should be collateralTypes.map((vm, brand) => ({
    return harden(
      Promise.all(
        [...collateralTypes.entries()].map(async ([brand, vm]) => {
          const priceQuote = await vm.getCollateralQuote();
          return {
            brand,
            interestRate: vm.getInterestRate(),
            liquidationMargin: vm.getLiquidationMargin(),
            stabilityFee: vm.getLoanFee(),
            marketPrice: makeRatioFromAmounts(
              getAmountOut(priceQuote),
              getAmountIn(priceQuote),
            ),
          };
        }),
      ),
    );
  };

  // Eventually the reward pool will live elsewhere. For now it's here for
  // bookkeeping. It's needed in tests.
  const getRewardAllocation = () => rewardPoolSeat.getCurrentAllocation();

  // TODO use named getters of TypedParamManager
  const getGovernedParams = paramDesc => {
    return vaultParamManagers.get(paramDesc.collateralBrand).getParams();
  };

  const getCollateralManager = brandIn => {
    assert(
      collateralTypes.has(brandIn),
      X`Not a supported collateral type ${brandIn}`,
    );
    /** @type {VaultManager} */
    return collateralTypes.get(brandIn).getPublicFacet();
  };

  const publicFacet = Far('vaultFactory public facet', {
    getCollateralManager,
    /** @deprecated use makeVaultInvitation instead */
    makeLoanInvitation: makeVaultInvitation,
    /** @deprecated use getCollateralManager and then makeVaultInvitation instead */
    makeVaultInvitation,
    getCollaterals,
    getRunIssuer: () => debtIssuer,
    getGovernedParams,
    getContractGovernor: () => governorPublic,
    getInvitationAmount: electorateParamManager.getInvitationAmount,
  });

  const { makeCollectFeesInvitation } = makeMakeCollectFeesInvitation(
    zcf,
    rewardPoolSeat,
    debtBrand,
    'RUN',
  );

  const getParamMgrRetriever = () =>
    Far('paramManagerRetriever', {
      get: paramDesc => {
        if (paramDesc.key === 'main') {
          return electorateParamManager;
        } else {
          return vaultParamManagers.get(paramDesc.collateralBrand);
        }
      },
    });

  /** @type {VaultFactory} */
  const vaultFactory = Far('vaultFactory machine', {
    // TODO move this under governance #3972
    addVaultType,
    getCollaterals,
    getRewardAllocation,
    makeCollectFeesInvitation,
    getContractGovernor: () => electionManager,
  });

  const vaultFactoryWrapper = Far('powerful vaultFactory wrapper', {
    getParamMgrRetriever,
    getInvitation: electorateParamManager.getInternalParamValue,
    getLimitedCreatorFacet: () => vaultFactory,
    getGovernedApis: () => harden({}),
    getGovernedApiNames: () => harden({}),
  });

  return harden({
    creatorFacet: vaultFactoryWrapper,
    publicFacet,
  });
};

/** @typedef {ContractOf<typeof start>} VaultFactoryContract */
