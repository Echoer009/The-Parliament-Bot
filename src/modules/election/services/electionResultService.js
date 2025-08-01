const { ElectionData, RegistrationData, VoteData } = require('../data/electionDatabase');
const { 
    detectBoundaryTies, 
    analyzeChainEffects, 
    assignCandidateStatuses,
    analyzeCrossPositionDependencies,
    recalculateWithDependencies
} = require('../utils/tieBreakingUtils');

/**
 * 计算并处理一个完整募选的最终结果，包括所有职位的计票、第二志愿逻辑、职位依赖和并列分析。
 * @param {string} electionId - 要计算结果的募选ID。
 * @returns {Promise<object>} 一个包含所有职位最终结果的复杂对象。
 */
async function calculateElectionResults(electionId) {
    try {
        // 获取募选信息
        const election = await ElectionData.getById(electionId);
        if (!election) {
            throw new Error('募选不存在');
        }

        // 获取所有投票和报名数据
        const votes = await VoteData.getByElection(electionId);
        const registrations = await RegistrationData.getByElection(electionId);

        const results = {};

        // 为每个职位计算结果
        for (const [positionId, position] of Object.entries(election.positions)) {
            results[positionId] = await calculatePositionResults(
                positionId, 
                position, 
                votes, 
                registrations
            );
        }

        // 处理第二志愿逻辑和当选状态
        const preliminaryResults = await processElectionLogic(results, election.positions, registrations);

        // 新增：分析跨职位依赖关系
        const dependencies = analyzeCrossPositionDependencies(preliminaryResults, registrations);
        
        // 新增：重新计算考虑依赖关系的状态
        const resultsWithDependencies = recalculateWithDependencies(preliminaryResults, dependencies);

        // 处理并列情况分析
        const finalResults = await processTieAnalysis(resultsWithDependencies, election.positions, registrations);

        return finalResults;

    } catch (error) {
        console.error('计算募选结果时出错:', error);
        throw error;
    }
}

/**
 * 计算单个职位的结果
 * @param {string} positionId - 职位ID
 * @param {object} position - 职位信息
 * @param {Array<object>} votes - 本次募选的所有投票数据。
 * @param {Array<object>} registrations - 本次募选的所有报名数据。
 * @returns {Promise<object>} 包含该职位候选人列表、总票数等信息的初步结果对象。
 */
async function calculatePositionResults(positionId, position, votes, registrations) {
    // 获取该职位的所有候选人（包括第一志愿和第二志愿）
    const firstChoiceCandidates = registrations.filter(reg => 
        reg.firstChoicePosition === positionId
    );
    const secondChoiceCandidates = registrations.filter(reg => 
        reg.secondChoicePosition === positionId
    );

    // 合并候选人列表，正确标记志愿类型
    const allCandidates = [];
    
    // 添加第一志愿候选人
    firstChoiceCandidates.forEach(reg => {
        allCandidates.push({
            ...reg,
            choiceType: 'first'
        });
    });
    
    // 添加第二志愿候选人（去重）
    secondChoiceCandidates.forEach(reg => {
        if (!allCandidates.find(c => c.userId === reg.userId)) {
            allCandidates.push({
                ...reg,
                choiceType: 'second'
            });
        }
    });

    if (allCandidates.length === 0) {
        return {
            position: position,
            candidates: [],
            totalVotes: 0,
            totalVoters: 0,
            isVoid: true,
            voidReason: '无人报名参选'
        };
    }

    // 找到该职位的投票数据
    const positionVote = votes.find(vote => vote.positionId === positionId);
    
    if (!positionVote || !positionVote.votes || Object.keys(positionVote.votes).length === 0) {
        // 没有投票，但有候选人
        const candidateResults = allCandidates.map(candidate => ({
            userId: candidate.userId,
            displayName: candidate.userDisplayName,
            votes: 0,
            isWinner: false,
            choiceType: candidate.choiceType
        }));

        return {
            position: position,
            candidates: candidateResults,
            totalVotes: 0,
            totalVoters: 0,
            isVoid: true,
            voidReason: '无人投票，该职位募选作废'
        };
    }

    // 统计每个候选人的票数
    const candidateVotes = {};
    let totalVotes = 0;
    let totalVoters = 0;

    // 初始化所有候选人的票数
    for (const candidate of allCandidates) {
        candidateVotes[candidate.userId] = {
            userId: candidate.userId,
            displayName: candidate.userDisplayName,
            votes: 0,
            isWinner: false,
            choiceType: candidate.choiceType
        };
    }

    // 计算票数和投票人数
    totalVoters = Object.keys(positionVote.votes).length; // 参与投票的人数
    
    for (const [voterId, candidateIds] of Object.entries(positionVote.votes)) {
        if (Array.isArray(candidateIds)) {
            for (const candidateId of candidateIds) {
                if (candidateVotes[candidateId]) {
                    candidateVotes[candidateId].votes++;
                    totalVotes++; // 总票数（可能大于投票人数，因为每人可投多票）
                }
            }
        }
    }

    // 转换为数组并按票数排序，第一志愿优先
    const candidateList = Object.values(candidateVotes)
        .sort((a, b) => {
            // 先按票数排序
            if (b.votes !== a.votes) {
                return b.votes - a.votes;
            }
            // 票数相同时，第一志愿优先
            if (a.choiceType === 'first' && b.choiceType === 'second') {
                return -1;
            }
            if (a.choiceType === 'second' && b.choiceType === 'first') {
                return 1;
            }
            return 0;
        });

    return {
        position: position,
        candidates: candidateList,
        totalVotes: totalVotes,
        totalVoters: totalVoters,
        isVoid: false
    };
}

/**
 * 处理募选逻辑和确定当选者
 * @param {object} preliminaryResults - 初步结果
 * @param {object} positions - 职位配置
 * @param {Array} registrations - 报名数据
 * @returns {object} 最终结果
 */
async function processElectionLogic(preliminaryResults, positions, registrations) {
    const finalResults = JSON.parse(JSON.stringify(preliminaryResults));
    const winners = new Set(); // 记录已当选的用户

    // 第一阶段：处理所有职位的第一志愿候选人
    for (const [positionId, result] of Object.entries(finalResults)) {
        if (result.isVoid) continue;

        const position = positions[positionId];
        const maxWinners = position.maxWinners;

        // 只考虑第一志愿候选人
        const firstChoiceCandidates = result.candidates
            .filter(c => c.choiceType === 'first' && c.votes > 0)
            .sort((a, b) => b.votes - a.votes);

        // 标记第一志愿当选者
        for (let i = 0; i < Math.min(maxWinners, firstChoiceCandidates.length); i++) {
            const candidate = firstChoiceCandidates[i];
            // 在原数组中找到对应候选人并标记
            const originalCandidate = result.candidates.find(c => c.userId === candidate.userId);
            if (originalCandidate) {
                originalCandidate.isWinner = true;
                winners.add(candidate.userId);
            }
        }
    }

    // 第二阶段：处理第二志愿候选人（填补空缺）
    for (const [positionId, result] of Object.entries(finalResults)) {
        if (result.isVoid) continue;

        const position = positions[positionId];
        const maxWinners = position.maxWinners;

        // 计算当前已当选人数
        const currentWinners = result.candidates.filter(c => c.isWinner).length;
        const remainingSlots = maxWinners - currentWinners;

        if (remainingSlots > 0) {
            // 获取第二志愿候选人（排除已在其他职位当选的）
            const secondChoiceCandidates = result.candidates
                .filter(c => 
                    c.choiceType === 'second' && 
                    c.votes > 0 && 
                    !winners.has(c.userId) && 
                    !c.isWinner
                )
                .sort((a, b) => b.votes - a.votes);

            // 标记第二志愿当选者
            for (let i = 0; i < Math.min(remainingSlots, secondChoiceCandidates.length); i++) {
                const candidate = secondChoiceCandidates[i];
                // 在原数组中找到对应候选人并标记
                const originalCandidate = result.candidates.find(c => c.userId === candidate.userId);
                if (originalCandidate) {
                    originalCandidate.isWinner = true;
                    winners.add(candidate.userId);
                }
            }
        }
    }

    // 第三阶段：最终检查和清理
    // 确保没有人在多个职位同时当选（优先第一志愿）
    const finalWinners = new Set();
    
    // 先处理所有第一志愿当选者
    for (const [positionId, result] of Object.entries(finalResults)) {
        if (result.isVoid) continue;
        
        result.candidates.forEach(candidate => {
            if (candidate.isWinner && candidate.choiceType === 'first') {
                finalWinners.add(candidate.userId);
            }
        });
    }
    
    // 再处理第二志愿当选者，如果已在第一志愿当选则取消第二志愿当选
    for (const [positionId, result] of Object.entries(finalResults)) {
        if (result.isVoid) continue;
        
        const position = positions[positionId];
        const maxWinners = position.maxWinners;
        
        result.candidates.forEach(candidate => {
            if (candidate.isWinner && candidate.choiceType === 'second' && finalWinners.has(candidate.userId)) {
                // 取消第二志愿当选
                candidate.isWinner = false;
            } else if (candidate.isWinner && candidate.choiceType === 'second') {
                finalWinners.add(candidate.userId);
            }
        });
        
        // 重新填补因取消第二志愿当选而空出的位置
        const currentWinners = result.candidates.filter(c => c.isWinner).length;
        const remainingSlots = maxWinners - currentWinners;
        
        if (remainingSlots > 0) {
            const availableCandidates = result.candidates
                .filter(c => 
                    !c.isWinner && 
                    c.votes > 0 && 
                    !finalWinners.has(c.userId)
                )
                .sort((a, b) => b.votes - a.votes);
            
            for (let i = 0; i < Math.min(remainingSlots, availableCandidates.length); i++) {
                const candidate = availableCandidates[i];
                candidate.isWinner = true;
                finalWinners.add(candidate.userId);
            }
        }
    }

    return finalResults;
}

/**
 * 获取募选统计信息
 * @param {string} electionId - 募选ID
 * @returns {object} 统计信息
 */
async function getElectionStatistics(electionId) {
    try {
        const election = await ElectionData.getById(electionId);
        const registrations = await RegistrationData.getByElection(electionId);
        const votes = await VoteData.getByElection(electionId);

        const stats = {
            election: {
                name: election.name,
                status: election.status,
                positionCount: Object.keys(election.positions).length
            },
            registration: {
                total: registrations.length,
                byPosition: {}
            },
            voting: {
                totalVoters: 0,
                byPosition: {}
            }
        };

        // 统计各职位报名人数
        for (const [positionId, position] of Object.entries(election.positions)) {
            const firstChoiceCount = registrations.filter(
                reg => reg.firstChoicePosition === positionId
            ).length;
            const secondChoiceCount = registrations.filter(
                reg => reg.secondChoicePosition === positionId
            ).length;

            stats.registration.byPosition[positionId] = {
                positionName: position.name,
                firstChoice: firstChoiceCount,
                secondChoice: secondChoiceCount,
                total: firstChoiceCount + secondChoiceCount
            };
        }

        // 统计投票情况
        for (const vote of votes) {
            const voterCount = Object.keys(vote.votes || {}).length;
            stats.voting.byPosition[vote.positionId] = {
                positionName: election.positions[vote.positionId]?.name || '未知职位',
                voterCount: voterCount,
                candidateCount: vote.candidates?.length || 0
            };
            stats.voting.totalVoters = Math.max(stats.voting.totalVoters, voterCount);
        }

        return stats;

    } catch (error) {
        console.error('获取募选统计信息时出错:', error);
        throw error;
    }
}

/**
 * 生成募选报告
 * @param {string} electionId - 募选ID
 * @returns {object} 募选报告
 */
async function generateElectionReport(electionId) {
    try {
        const results = await calculateElectionResults(electionId);
        const statistics = await getElectionStatistics(electionId);
        const election = await ElectionData.getById(electionId);

        return {
            election: {
                id: electionId,
                name: election.name,
                status: election.status,
                schedule: election.schedule
            },
            statistics: statistics,
            results: results,
            generatedAt: new Date().toISOString()
        };

    } catch (error) {
        console.error('生成募选报告时出错:', error);
        throw error;
    }
}

/**
 * 处理并列情况分析
 * @param {object} results - 选举结果
 * @param {object} positions - 职位配置
 * @param {Array} registrations - 报名数据
 * @returns {object} 带并列分析的结果
 */
async function processTieAnalysis(results, positions, registrations) {
    const analysisResults = JSON.parse(JSON.stringify(results));

    // 第一步：为每个职位检测并列情况
    for (const [positionId, result] of Object.entries(analysisResults)) {
        if (result.isVoid) {
            result.tieAnalysis = { hasTies: false, tieGroups: [] };
            continue;
        }

        const position = positions[positionId];
        const maxWinners = position.maxWinners;

        // 检测边界并列
        const tieAnalysis = detectBoundaryTies(result.candidates, maxWinners);
        result.tieAnalysis = tieAnalysis;
    }

    // 第二步：分析连锁影响
    const chainEffects = analyzeChainEffects(analysisResults, registrations);

    // 第三步：为所有候选人分配状态
    const finalResults = assignCandidateStatuses(analysisResults, chainEffects);

    // 第四步：添加全局分析信息
    finalResults._tieAnalysis = {
        hasAnyTies: Object.values(finalResults).some(result => result.tieAnalysis?.hasTies),
        chainEffects: chainEffects,
        analysisTimestamp: new Date().toISOString()
    };

    return finalResults;
}

module.exports = {
    calculateElectionResults,
    calculatePositionResults,
    processElectionLogic,
    processTieAnalysis,
    getElectionStatistics,
    generateElectionReport
}; 