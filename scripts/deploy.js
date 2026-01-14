const { ethers } = require("hardhat");
const fs = require("fs");

async function main() {
    const [deployer] = await ethers.getSigners();
    
    console.log("Deploying BaseAlphaArb with account:", deployer.address);
    console.log("Account balance:", (await deployer.provider.getBalance(deployer.address)).toString());
    
    // Deploy the contract
    const BaseAlphaArb = await ethers.getContractFactory("BaseAlphaArb");
    const arb = await BaseAlphaArb.deploy();
    
    await arb.waitForDeployment();
    
    const contractAddress = await arb.getAddress();
    console.log("BaseAlphaArb deployed to:", contractAddress);
    console.log("Owner:", deployer.address);
    
    // Wait for 5 confirmations
    console.log("Waiting for confirmations...");
    await arb.deploymentTransaction().wait(5);
    
    // Save deployment info
    const deploymentInfo = {
        address: contractAddress,
        network: 'base',
        deployer: deployer.address,
        timestamp: new Date().toISOString(),
        transactionHash: arb.deploymentTransaction().hash,
        blockNumber: await ethers.provider.getBlockNumber()
    };
    
    fs.writeFileSync(
        './deployment-info.json',
        JSON.stringify(deploymentInfo, null, 2)
    );
    
    console.log("Deployment info saved to deployment-info.json");
    
    // Verify contract on Basescan
    console.log("Verifying contract on Basescan...");
    try {
        await run("verify:verify", {
            address: contractAddress,
            constructorArguments: [],
        });
        console.log("Contract verified successfully!");
    } catch (error) {
        console.log("Verification failed:", error.message);
    }
    
    // Initialize aggregator approvals
    console.log("Setting up aggregator approvals...");
    // This will happen automatically in constructor
    
    console.log("Deployment completed successfully!");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
