import bcrypt from 'bcrypt';
import { IUserInputDTO } from '../../interface/IUser';
import { User } from './user.schema';
import { generateRefreshToken, generateToken } from '../../utils/jwt';
import { Team } from '../team/team.schema';
import { Image } from '../image/image.schema';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import { AppError } from '../../middleware/error.handler.middleware';
import mongoose from 'mongoose';

const SALT_ROUNDS = 10;

const UserService = {
  register: async (data: IUserInputDTO, imageUrl?: string) => {
    const existingUser = await User.findOne({ email: data.email });

    if (existingUser) {
      throw new AppError('Bad Request', 400, '이미 존재하는 이메일입니다.');
    }

    const hashedPassword = await bcrypt.hash(data.password!, SALT_ROUNDS);

    const user = new User({
      ...data,
      password: hashedPassword,
      avatar: imageUrl || 'N/A',
    });

    const savedUser = await user.save();

    if (imageUrl) {
      const image = new Image({
        user_id: savedUser._id,
        imageUrl: imageUrl,
      });
      await image.save();
    }

    const token = jwt.sign({ id: savedUser._id }, process.env.JWT_SECRET || 'invitationToken', {
      expiresIn: '7d',
    });
    savedUser.invitationToken = token;

    await savedUser.save();

    return {
      ...savedUser.toObject(),
      invitationToken: token,
    };
  },

  sendTeamConfirmationEmail: async (user: any, token: string) => {
    const link = `${process.env.CONFIRMATION_TEAM_LINK}/${token}`;

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GOOGLE_EMAIL,
        pass: process.env.GOOGLE_EMAIL_PASSWORD,
      },
    });

    const mailOptions = {
      from: process.env.GOOGLE_EMAIL,
      to: user.email,
      subject: '팀 소속 확인',
      text: `팀 소속을 확인하려면 다음 링크를 클릭하세요: ${link}`,
    };

    await transporter.sendMail(mailOptions);
  },

  confirmTeam: async (token: string, team: string) => {
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || 'invitationToken') as { id: string };
    } catch (error) {
      throw new AppError('Unauthorized', 401, '유효하지 않은 토큰입니다.');
    }

    const user = await User.findById(decoded.id);

    if (!user) throw new AppError('Not Found', 404, '사용자를 찾을 수 없습니다.');
    if (user.invitationToken !== token) {
      throw new AppError('Unauthorized', 401, '잘못된 토큰입니다.');
    }

    let existingTeam = await Team.findOne({ team: team });

    if (!existingTeam) {
      existingTeam = new Team({
        user_id: user._id,
        team: team,
        members: [user._id],
      });
    } else {
      if (!existingTeam.members.includes(user._id)) {
        existingTeam.members.push(user._id);
      }
    }

    await existingTeam.save();

    user.team_id = existingTeam._id;
    user.invitationToken = undefined;
    await user.save();

    return user;
  },

  logIn: async (email: string, password: string) => {
    const user = await User.findOne({ email });
    if (!user) throw new AppError('Unauthorized', 401, '아이디 혹은 패스워드를 확인해주세요');

    const checkPassword = await bcrypt.compare(password, user.password!);
    if (!checkPassword) throw new AppError('Unauthorized', 401, '아이디 혹은 패스워드를 확인해주세요');

    const accessToken = generateToken(user._id.toString());
    const refreshToken = generateRefreshToken(user._id.toString());

    user.refreshToken = refreshToken;
    await user.save();

    const teamData = await Team.findOne({ members: user._id });

    return {
      user,

      accessToken,
      refreshToken,
      // team: teamData ? teamData.team : null,
      team: teamData,
    };
  },

  logout: async (refreshToken: string) => {
    await User.updateOne({ refreshToken }, { $set: { refreshToken: null } });
  },

  resetPassword: async (token: string, newPassword: string) => {
    let decoded;
    try {
      decoded = jwt.verify(token, 'resetToken') as { id: string };
    } catch (error) {
      throw new AppError('Unauthorized', 401, '유효하지 않은 토큰입니다.');
    }

    const user = await User.findById(decoded.id);
    if (!user) {
      throw new AppError('Unauthorized', 401, '사용자를 찾을 수 없습니다.');
    }

    if (user.resetToken !== token) {
      throw new AppError('Unauthorized', 401, '토큰이 유효하지 않습니다.');
    }

    const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
    user.password = hashedPassword;
    user.resetToken = undefined;
    await user.save();

    return user;
  },

  requestPasswordReset: async (email: string) => {
    const user = await User.findOne({ email });
    if (!user) throw new AppError('Not Found', 404, '해당 이메일을 사용하는 사용자가 없습니다.');

    const resetToken = jwt.sign({ id: user._id }, 'resetToken', {
      expiresIn: '1h',
    });
    user.resetToken = resetToken;
    await user.save();

    const resetLink = `${process.env.RESET_PASSWORD_LINK}/${resetToken}`;
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GOOGLE_EMAIL,
        pass: process.env.GOOGLE_EMAIL_PASSWORD,
      },
    });

    const mailOptions = {
      from: process.env.GOOGLE_EMAIL,
      to: user.email,
      subject: '비밀번호 재설정 요청',
      text: `비밀번호를 재설정하려면 다음 링크를 클릭하세요: ${resetLink}`,
    };

    await transporter.sendMail(mailOptions);
  },

  updateUserAvatar: async (userId: string, avatarPath: string): Promise<void> => {
    const existingImage = await Image.findOne({ user_id: userId });

    if (existingImage) {
      existingImage.imageUrl = avatarPath;
      await existingImage.save();
    } else {
      const newImage = new Image({
        user_id: userId,
        imageUrl: avatarPath,
      });
      await newImage.save();
    }

    await User.updateOne({ _id: userId }, { $set: { avatar: avatarPath } });
  },

  updateUserPassword: async (
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ status: string; message: string }> => {
    const user = await User.findById(userId);

    if (!user) {
      throw new AppError('Not Found', 404, '사용자를 찾을 수 없습니다.');
    }

    const isPasswordMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isPasswordMatch) {
      return { status: 'error', message: 'not match' };
    }

    const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
    user.password = hashedPassword;

    await user.save();

    return { status: 'success', message: 'password updated' };
  },

  // 팀에 속한 유저만 조회 가능
  // 1팀유저는 1팀 유저만 검색 가능
  getUser: async (searchInfo: string, userId: string, page: number, limit: number) => {
    const skip = (page - 1) * limit;

    const userTeam = await Team.findOne({ members: userId });

    if (!userTeam || !userTeam.members || userTeam.members.length === 0) {
      throw new AppError('Not Found', 404, '해당 유저를 찾을 수 없습니다.');
    }

    const users = await User.aggregate([
      {
        $match: {
          _id: { $in: userTeam.members },
          name: { $regex: searchInfo, $options: 'i' },
        },
      },
      {
        $project: {
          name: 1,
          email: 1,
          avatar: 1,
        },
      },
      { $skip: skip },
      { $limit: limit },
    ]);

    if (users.length === 0) {
      throw new AppError('Not Found', 404, '해당 유저를 찾을 수 없습니다.');
    }

    const totalUsers = await User.countDocuments({
      _id: { $in: userTeam.members },
      name: { $regex: searchInfo, $options: 'i' },
    });

    return {
      users,
      totalPages: Math.ceil(totalUsers / limit),
      currentPage: page,
    };
  },

  getAllUsers: async (page: number, limit: number) => {
    const skip = (page - 1) * limit;

    const users = await User.aggregate([
      { $match: { _id: User } },
      {
        $lookup: {
          from: 'projects',
          localField: '_id',
          foreignField: 'user_id',
          as: 'createdProjects',
        },
      },
      {
        $lookup: {
          from: 'projects',
          localField: '_id',
          foreignField: 'team_id',
          as: 'teamProjects',
        },
      },
      {
        $lookup: {
          from: 'teams',
          localField: 'team_id',
          foreignField: '_id',
          as: 'teamInfo',
        },
      },
      {
        $lookup: {
          from: 'tasks',
          localField: '_id',
          foreignField: 'user_id',
          as: 'createdTasks',
        },
      },
      {
        $lookup: {
          from: 'tasks',
          localField: '_id',
          foreignField: 'taskMember',
          as: 'assignedTasks',
        },
      },
      { $skip: skip },
      { $limit: limit },
    ]);

    if (!users || users.length === 0) {
      throw new AppError('Not Found', 404, '해당 유저를 찾을 수 없습니다.');
    }

    const totalUsers = await User.countDocuments();

    return {
      users,
      totalPages: Math.ceil(totalUsers / limit),
      currentPage: page,
    };
  },

  findById: async (userId: string) => {
    const user = await User.findById(userId).select('-password');
    return user;
  },

  getUserByIdWithTeam: async (userId: string) => {
    const user = await User.aggregate([
      {
        $match: { _id: new mongoose.Types.ObjectId(userId) },
      },
      {
        $lookup: {
          from: 'teams',
          localField: 'team_id',
          foreignField: '_id',
          as: 'teamInfo',
        },
      },
      {
        $unwind: {
          path: '$teamInfo',
          preserveNullAndEmptyArrays: true, // 팀이 없는 경우에도 결과 반환
        },
      },
      {
        $project: {
          _id: 1,
          name: 1,
          email: 1,
          avatar: 1,
          team: { $ifNull: ['$teamInfo.team', 'N/A'] }, // teamInfo가 없으면 'N/A' 반환
        },
      },
    ]);

    if (!user || user.length === 0) {
      throw new AppError('Not Found', 404, '사용자를 찾을 수 없습니다.');
    }

    return user[0]; // 배열의 첫 번째 요소 반환
  },
};

export default UserService;
