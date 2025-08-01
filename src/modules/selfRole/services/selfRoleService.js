// src/modules/selfRole/services/selfRoleService.js

const { ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getSelfRoleSettings, getUserActivity, saveSelfRoleApplication } = require('../../../core/utils/database');

/**
 * 处理用户点击“自助身份组申请”按钮的事件。
 * @param {import('discord.js').ButtonInteraction} interaction - 按钮交互对象。
 */
async function handleSelfRoleButton(interaction) {
    const guildId = interaction.guild.id;
    const settings = await getSelfRoleSettings(guildId);

    if (!settings || !settings.roles || settings.roles.length === 0) {
        return interaction.reply({ content: '❌ 当前没有任何可申请的身份组。', ephemeral: true });
    }

    const memberRoles = interaction.member.roles.cache;
    const options = settings.roles
        .filter(roleConfig => !memberRoles.has(roleConfig.roleId)) // 过滤掉用户已有的身份组
        .map(roleConfig => ({
            label: roleConfig.label,
            description: roleConfig.description || `申请 ${roleConfig.label} 身份组`,
            value: roleConfig.roleId,
        }));

    if (options.length === 0) {
        return interaction.reply({ content: '✅ 您已拥有所有可申请的身份组。', ephemeral: true });
    }

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('self_role_select_menu')
        .setPlaceholder('请选择要申请的身份组...')
        .addOptions(options);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.reply({
        content: '请从下面的菜单中选择您想申请的身份组：',
        components: [row],
        ephemeral: true,
    });

    // 60秒后自动删除此消息
    setTimeout(() => {
        interaction.deleteReply().catch(() => {});
    }, 60000);
}

/**
 * 处理用户在下拉菜单中选择身份组后的提交事件。
 * @param {import('discord.js').StringSelectMenuInteraction} interaction - 字符串选择菜单交互对象。
 */
async function handleSelfRoleSelect(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guild.id;
    const member = interaction.member;
    const selectedRoleIds = interaction.values;

    const settings = await getSelfRoleSettings(guildId);
    const userActivity = await getUserActivity(guildId);

    let results = [];

    for (const roleId of selectedRoleIds) {
        const roleConfig = settings.roles.find(r => r.roleId === roleId);
        if (!roleConfig) continue;

        const { conditions } = roleConfig;
        const failureReasons = [];

        // 1. 检查前置身份组
        if (conditions.prerequisiteRoleId && !member.roles.cache.has(conditions.prerequisiteRoleId)) {
            const requiredRole = await interaction.guild.roles.fetch(conditions.prerequisiteRoleId);
            failureReasons.push(`需要拥有 **${requiredRole.name}** 身份组`);
        }

        // 2. 检查活跃度
        if (conditions.activity) {
            const { channelId, requiredMessages, requiredMentions, requiredMentioning } = conditions.activity;
            const activity = userActivity[channelId]?.[member.id] || { messageCount: 0, mentionedCount: 0, mentioningCount: 0 };
            const channel = await interaction.guild.channels.fetch(channelId).catch(() => ({ id: channelId }));

            if (activity.messageCount < requiredMessages) {
                failureReasons.push(`在 <#${channel.id}> 发言数需达到 **${requiredMessages}** (当前: ${activity.messageCount})`);
            }
            if (activity.mentionedCount < requiredMentions) {
                failureReasons.push(`在 <#${channel.id}> 被提及数需达到 **${requiredMentions}** (当前: ${activity.mentionedCount})`);
            }
            if (activity.mentioningCount < requiredMentioning) {
                failureReasons.push(`在 <#${channel.id}> 主动提及数需达到 **${requiredMentioning}** (当前: ${activity.mentioningCount})`);
            }
        }

        const canApply = failureReasons.length === 0;

        if (canApply) {
            // 如果资格预审通过，检查是否需要审核
            if (conditions.approval) {
                try {
                    await createApprovalPanel(interaction, roleConfig);
                    results.push(`⏳ **${roleConfig.label}**: 资格审查通过，已提交社区审核。`);
                } catch (error) {
                    console.error(`[SelfRole] ❌ 创建审核面板时出错 for ${roleConfig.label}:`, error);
                    results.push(`❌ **${roleConfig.label}**: 提交审核失败，请联系管理员。`);
                }
            }
            // 如果资格预审通过且无需审核，则直接授予
            else {
                try {
                    await member.roles.add(roleId);
                    results.push(`✅ **${roleConfig.label}**: 成功获取！`);
                } catch (error) {
                    console.error(`[SelfRole] ❌ 授予身份组 ${roleConfig.label} 时出错:`, error);
                    results.push(`❌ **${roleConfig.label}**: 授予失败，可能是机器人权限不足。`);
                }
            }
        } else {
            // 如果资格预审不通过
            results.push(`❌ **${roleConfig.label}**: 申请失败，原因：${failureReasons.join('； ')}`);
        }
    }

    await interaction.editReply({
        content: `**身份组申请结果:**\n\n${results.join('\n')}`,
    });

    // 60秒后自动删除此消息
    setTimeout(() => {
        interaction.deleteReply().catch(() => {});
    }, 60000);
}

module.exports = {
    handleSelfRoleButton,
    handleSelfRoleSelect,
};

/**
 * 为需要审核的身份组申请创建一个投票面板。
 * @param {import('discord.js').StringSelectMenuInteraction} interaction - 原始的菜单交互对象。
 * @param {object} roleConfig - 所申请身份组的具体配置。
 */
async function createApprovalPanel(interaction, roleConfig) {
    const { approval } = roleConfig.conditions;
    const applicant = interaction.user;
    const role = await interaction.guild.roles.fetch(roleConfig.roleId);

    const approvalChannel = await interaction.client.channels.fetch(approval.channelId);
    if (!approvalChannel) {
        throw new Error(`找不到配置的审核频道: ${approval.channelId}`);
    }

    const embed = new EmbedBuilder()
        .setTitle(`📜 身份组申请审核: ${roleConfig.label}`)
        .setDescription(`用户 **${applicant.tag}** (${applicant.id}) 申请获取 **${role.name}** 身份组，已通过资格预审，现进入社区投票审核阶段。`)
        .addFields(
            { name: '申请人', value: `<@${applicant.id}>`, inline: true },
            { name: '申请身份组', value: `<@&${role.id}>`, inline: true },
            { name: '状态', value: '🗳️ 投票中...', inline: true },
            { name: '支持票数', value: `0 / ${approval.requiredApprovals}`, inline: true },
            { name: '反对票数', value: `0 / ${approval.requiredRejections}`, inline: true }
        )
        .setColor(0xFEE75C) // Yellow
        .setTimestamp();

    const approveButton = new ButtonBuilder()
        .setCustomId(`self_role_approve_${roleConfig.roleId}_${applicant.id}`)
        .setLabel('✅ 支持')
        .setStyle(ButtonStyle.Success);

    const rejectButton = new ButtonBuilder()
        .setCustomId(`self_role_reject_${roleConfig.roleId}_${applicant.id}`)
        .setLabel('❌ 反对')
        .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(approveButton, rejectButton);

    const approvalMessage = await approvalChannel.send({ embeds: [embed], components: [row] });

    // 在数据库中创建申请记录
    await saveSelfRoleApplication(approvalMessage.id, {
        applicantId: applicant.id,
        roleId: roleConfig.roleId,
        status: 'pending',
        approvers: [],
        rejecters: [],
    });

    console.log(`[SelfRole] ✅ 为 ${applicant.tag} 的 ${roleConfig.label} 申请创建了审核面板: ${approvalMessage.id}`);
}