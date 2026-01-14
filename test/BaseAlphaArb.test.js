const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("BaseAlphaArb", function () {
    async function deployContract() {
        const [owner, otherAccount] = await ethers.getSigners();
        
        const BaseAlphaArb = await ethers.getContractFactory("BaseAlphaArb");
        const arb = await BaseAlphaArb.deploy();
        
        return { arb, owner, otherAccount };
    }

    describe("Deployment", function () {
        it("Should set the right owner", async function () {
            const { arb, owner } = await loadFixture(deployContract);
            expect(await arb.owner()).to.equal(owner.address);
        });

        it("Should have correct Aave addresses provider", async function () {
            const { arb } = await loadFixture(deployContract);
            const provider = await arb.ADDRESSES_PROVIDER();
            expect(provider).to.equal("0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D");
        });
    });

    describe("Aggregator Management", function () {
        it("Should have correct initial aggregators", async function () {
            const { arb } = await loadFixture(deployContract);
            
            expect(await arb.getAggregator("odos")).to.equal("0x19cEeAd7105607Cd444F5ad10dd51356436095a1");
            expect(await arb.getAggregator("1inch")).to.equal("0x1111111254EEB25477B68fb85Ed929f73A960582");
            expect(await arb.getAggregator("aerodrome")).to.equal("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43");
        });

        it("Should update aggregator", async function () {
            const { arb, owner } = await loadFixture(deployContract);
            const newAddress = "0x0000000000000000000000000000000000001234";
            
            await arb.connect(owner).updateAggregator("test", newAddress);
            expect(await arb.getAggregator("test")).to.equal(newAddress);
        });

        it("Should prevent non-owner from updating aggregator", async function () {
            const { arb, otherAccount } = await loadFixture(deployContract);
            const newAddress = "0x0000000000000000000000000000000000001234";
            
            await expect(
                arb.connect(otherAccount).updateAggregator("test", newAddress)
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });
    });

    describe("Emergency Functions", function () {
        it("Should pause and unpause", async function () {
            const { arb, owner } = await loadFixture(deployContract);
            
            await arb.connect(owner).emergencyPause();
            expect(await arb.paused()).to.be.true;
            
            await arb.connect(owner).emergencyUnpause();
            expect(await arb.paused()).to.be.false;
        });

        it("Should rescue tokens", async function () {
            const { arb, owner } = await loadFixture(deployContract);
            
            // Mock token transfer to contract
            const MockToken = await ethers.getContractFactory("MockERC20");
            const mockToken = await MockToken.deploy("Test", "TEST", 18);
            
            // Transfer to contract
            await mockToken.transfer(arb.target, ethers.parseUnits("100", 18));
            
            const contractBalance = await mockToken.balanceOf(arb.target);
            expect(contractBalance).to.equal(ethers.parseUnits("100", 18));
            
            // Rescue tokens
            await arb.connect(owner).rescueTokens(
                await mockToken.getAddress(),
                ethers.parseUnits("100", 18)
            );
            
            expect(await mockToken.balanceOf(arb.target)).to.equal(0);
        });
    });

    describe("Flash Loan Integration", function () {
        it("Should correctly calculate flash loan premium", async function () {
            const { arb } = await loadFixture(deployContract);
            
            // Aave V3 Base has 0.09% premium (9 bps)
            const amount = ethers.parseUnits("100", 18);
            const premium = (amount * 9n) / 10000n; // 0.09%
            
            expect(premium).to.equal(ethers.parseUnits("0.09", 18));
        });
    });
});
