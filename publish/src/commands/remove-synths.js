'use strict';

const fs = require('fs');
const { gray, yellow, red, cyan, green } = require('chalk');
const ethers = require('ethers');

const {
	toBytes32,
	getUsers,
	constants: { CONFIG_FILENAME, DEPLOYMENT_FILENAME, ZERO_ADDRESS },
} = require('../../..');

const { getContract } = require('../command-utils/contract');
const {
	ensureNetwork,
	ensureDeploymentPath,
	getDeploymentPathForNetwork,
	loadAndCheckRequiredSources,
	loadConnections,
	confirmAction,
	stringify,
} = require('../util');

const { performTransactionalStep } = require('../command-utils/transact');

const DEFAULTS = {
	network: 'goerli',
	gasLimit: 3e5,
	priorityGasPrice: '1',
};

const removeSynths = async ({
	network = DEFAULTS.network,
	deploymentPath,
	maxFeePerGas,
	maxPriorityFeePerGas = DEFAULTS.priorityGasPrice,
	gasLimit = DEFAULTS.gasLimit,
	synthsToRemove = [],
	yes,
	useFork,
	dryRun = false,
	privateKey,
}) => {
	ensureNetwork(network);
	deploymentPath = deploymentPath || getDeploymentPathForNetwork({ network });
	ensureDeploymentPath(deploymentPath);

	const {
		synths,
		synthsFile,
		deployment,
		deploymentFile,
		config,
		configFile,
		ownerActions,
		ownerActionsFile,
	} = loadAndCheckRequiredSources({
		deploymentPath,
		network,
	});

	if (synthsToRemove.length < 1) {
		console.log(gray('No synths provided. Please use --synths-to-remove option'));
		return;
	}

	// sanity-check the synth list
	for (const synth of synthsToRemove) {
		if (synths.filter(({ name }) => name === synth).length < 1) {
			console.error(red(`Synth ${synth} not found!`));
			process.exitCode = 1;
			return;
		} else if (['sUSD'].indexOf(synth) >= 0) {
			console.error(red(`Synth ${synth} cannot be removed`));
			process.exitCode = 1;
			return;
		}
	}

	const { providerUrl, privateKey: envPrivateKey, explorerLinkPrefix } = loadConnections({
		network,
		useFork,
	});

	// if not specified, or in a local network, override the private key passed as a CLI option, with the one specified in .env
	if (network !== 'local' && !privateKey && !useFork) {
		privateKey = envPrivateKey;
	}

	const provider = new ethers.providers.JsonRpcProvider(providerUrl);
	let wallet;
	if (!privateKey) {
		const account = getUsers({ network, user: 'owner' }).address; // protocolDAO
		wallet = provider.getSigner(account);
		wallet.address = await wallet.getAddress();
	} else {
		wallet = new ethers.Wallet(privateKey, provider);
	}

	console.log(gray(`Using account with public key ${wallet.address}`));
	console.log(
		gray(
			`Using max base gas of ${maxFeePerGas} GWEI, miner tip ${maxPriorityFeePerGas} GWEI with a gas limit of ${gasLimit}`
		)
	);

	console.log(gray('Dry-run:'), dryRun ? green('yes') : yellow('no'));

	if (!yes) {
		try {
			await confirmAction(
				cyan(
					`${yellow(
						'⚠ WARNING'
					)}: This action will remove the following synths from the Synthetix contract on ${network}:\n- ${synthsToRemove.join(
						'\n- '
					)}`
				) + '\nDo you want to continue? (y/n) '
			);
		} catch (err) {
			console.log(gray('Operation cancelled'));
			return;
		}
	}

	const Synthetix = getContract({
		contract: 'Synthetix',
		network,
		deploymentPath,
		wallet,
	});

	const Issuer = getContract({
		contract: 'Issuer',
		network,
		deploymentPath,
		wallet,
	});

	const ExchangeRates = getContract({
		contract: 'ExchangeRates',
		network,
		deploymentPath,
		wallet,
	});

	const SystemStatus = getContract({
		contract: 'SystemStatus',
		network,
		deploymentPath,
		wallet,
	});

	// deep clone these configurations so we can mutate and persist them
	const updatedConfig = JSON.parse(JSON.stringify(config));
	const updatedDeployment = JSON.parse(JSON.stringify(deployment));
	let updatedSynths = JSON.parse(fs.readFileSync(synthsFile));

	for (const currencyKey of synthsToRemove) {
		const { address: synthAddress, source: synthSource } = deployment.targets[
			`Synth${currencyKey}`
		];
		const { abi: synthABI } = deployment.sources[synthSource];
		const Synth = new ethers.Contract(synthAddress, synthABI, wallet);

		const currentSynthInSNX = await Synthetix.synths(toBytes32(currencyKey));

		if (synthAddress !== currentSynthInSNX) {
			console.error(
				red(
					`Synth address in Synthetix for ${currencyKey} is different from what's deployed in Synthetix to the local ${DEPLOYMENT_FILENAME} of ${network} \ndeployed: ${yellow(
						currentSynthInSNX
					)}\nlocal:    ${yellow(synthAddress)}`
				)
			);
			process.exitCode = 1;
			return;
		}

		// now check total supply (is required in Synthetix.removeSynth)
		const totalSupply = ethers.utils.formatEther(await Synth.totalSupply());
		if (Number(totalSupply) > 0) {
			const totalSupplyInUSD = ethers.utils.formatEther(
				await ExchangeRates.effectiveValue(
					toBytes32(currencyKey),
					ethers.utils.parseEther(totalSupply),
					toBytes32('sUSD')
				)
			);
			try {
				await confirmAction(
					cyan(
						`Synth${currencyKey}.totalSupply is non-zero: ${yellow(totalSupply)} which is $${yellow(
							totalSupplyInUSD
						)}\n${red(`THIS WILL DEPRECATE THE SYNTH BY ITS PROXY. ARE YOU SURE???.`)}`
					) + '\nDo you want to continue? (y/n) '
				);
			} catch (err) {
				console.log(gray('Operation cancelled'));
				return;
			}
		}

		// perform transaction if owner of Synthetix or append to owner actions list
		if (dryRun) {
			console.log(green('Would attempt to remove the synth:', currencyKey));
		} else {
			await performTransactionalStep({
				signer: wallet,
				contract: 'Issuer',
				target: Issuer,
				write: 'removeSynth',
				writeArg: toBytes32(currencyKey),
				gasLimit,
				maxFeePerGas,
				maxPriorityFeePerGas,
				explorerLinkPrefix,
				ownerActions,
				ownerActionsFile,
				encodeABI: network === 'mainnet',
			});

			// now update the config and deployment JSON files
			const contracts = ['Proxy', 'TokenState', 'Synth'].map(name => `${name}${currencyKey}`);
			for (const contract of contracts) {
				delete updatedConfig[contract];
				delete updatedDeployment.targets[contract];
			}
			fs.writeFileSync(configFile, stringify(updatedConfig));
			fs.writeFileSync(deploymentFile, stringify(updatedDeployment));

			// and update the synths.json file
			updatedSynths = updatedSynths.filter(({ name }) => name !== currencyKey);
			fs.writeFileSync(synthsFile, stringify(updatedSynths));
		}

		// now try to remove rate
		if (dryRun) {
			console.log(green('Would attempt to remove the aggregator:', currencyKey));
		} else {
			await performTransactionalStep({
				signer: wallet,
				contract: 'ExchangeRates',
				target: ExchangeRates,
				read: 'aggregators',
				readArg: toBytes32(currencyKey),
				expected: input => input === ZERO_ADDRESS,
				write: 'removeAggregator',
				writeArg: toBytes32(currencyKey),
				gasLimit,
				explorerLinkPrefix,
				ownerActions,
				ownerActionsFile,
				encodeABI: network === 'mainnet',
			});
		}

		// now try to unsuspend the synth
		if (dryRun) {
			console.log(green('Would attempt to remove the synth:', currencyKey));
		} else {
			await performTransactionalStep({
				signer: wallet,
				contract: 'SystemStatus',
				target: SystemStatus,
				read: 'synthSuspension',
				readArg: toBytes32(currencyKey),
				expected: input => !input.suspended,
				write: 'resumeSynth',
				writeArg: toBytes32(currencyKey),
				gasLimit,
				explorerLinkPrefix,
				ownerActions,
				ownerActionsFile,
				encodeABI: network === 'mainnet',
			});
		}
	}
};

module.exports = {
	removeSynths,
	cmd: program =>
		program
			.command('remove-synths')
			.description('Remove a number of synths from the system')
			.option(
				'-d, --deployment-path <value>',
				`Path to a folder that has your input configuration file ${CONFIG_FILENAME} and where your ${DEPLOYMENT_FILENAME} files will go`
			)
			.option('-g, --max-fee-per-gas <value>', 'Maximum base gas fee price in GWEI')
			.option(
				'--max-priority-fee-per-gas <value>',
				'Priority gas fee price in GWEI',
				DEFAULTS.priorityGasPrice
			)
			.option('-l, --gas-limit <value>', 'Gas limit', 1e6)
			.option('-n, --network <value>', 'The network to run off.', x => x.toLowerCase(), 'goerli')
			.option('-r, --dry-run', 'Dry run - no changes transacted')
			.option(
				'-k, --use-fork',
				'Perform the deployment on a forked chain running on localhost (see fork command).',
				false
			)
			.option('-y, --yes', 'Dont prompt, just reply yes.')
			.option(
				'-s, --synths-to-remove <value>',
				'The list of synths to remove',
				(val, memo) => {
					memo.push(val);
					return memo;
				},
				[]
			)
			.action(removeSynths),
};
