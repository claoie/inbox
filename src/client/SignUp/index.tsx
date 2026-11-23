import { useState, useContext, useEffect, ChangeEvent, FormEvent } from "react";
import { useMutation } from "react-query";
import { useParams, useLocation, Link, Navigate } from "react-router-dom";

import SignUpIcon from "./components/SignUpIcon";
import UserEditIcon from "./components/UserEditIcon";

import { SignedUser, SignedUserType } from "common";
import { ApiResponse, SetInfoPostResponse, TokenPostResponse } from "server";
import {
  Context,
  call,
  getSignInMode,
  setCacheUser,
  hydrateQueryCache
} from "client";

import { copyFor, statusFor, SignUpMode } from "./messages";
import "../SignIn/index.scss";
import "./index.scss";

interface SignUpBody {
  email: string;
  token?: string | null;
  username?: string;
  password?: string;
}

const SignUp = () => {
  const { setUserInfo } = useContext(Context);

  const { email } = useParams<{ email: string }>();
  const query = new URLSearchParams(useLocation().search);
  const token = query.get("t");
  const username = query.get("u");

  const [emailInput, setEmailInput] = useState(email || "");
  const [usernameInput, setUsernameInput] = useState(username || "");
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordConfirmInput, setPasswordConfirmInput] = useState("");
  const [passwordMismatch, setPasswordMismatch] = useState(false);

  const onChangeEmail = (e: ChangeEvent<HTMLInputElement>) => {
    setEmailInput(e.target.value);
  };

  const onChangeUsername = (e: ChangeEvent<HTMLInputElement>) => {
    setUsernameInput(e.target.value);
  };

  const onChangePassword = (e: ChangeEvent<HTMLInputElement>) => {
    setPasswordInput(e.target.value);
    setPasswordMismatch(false);
  };

  const onChangePasswordConfirm = (e: ChangeEvent<HTMLInputElement>) => {
    setPasswordConfirmInput(e.target.value);
    setPasswordMismatch(false);
  };

  type DynamicResponse = SetInfoPostResponse | TokenPostResponse;
  type PromiseDynamicApiResponse = Promise<ApiResponse<DynamicResponse>>;

  const mutation = useMutation((body: SignUpBody): PromiseDynamicApiResponse => {
    if (email) {
      return call.post<SetInfoPostResponse>("/api/users/set-info", body);
    } else return call.post<TokenPostResponse>("/api/users/token", body);
  });

  const mode: SignUpMode = email
    ? "set-info"
    : query.get("mode") === "reset"
      ? "reset"
      : "signup";
  const copy = copyFor(mode);
  const status = statusFor({
    mode,
    passwordMismatch,
    isLoading: mutation.isLoading,
    isError: mutation.isError,
    data: mutation.data
  });

  useEffect(() => {
    if (!email || mutation.data?.status !== "success" || !setUserInfo) return;
    const body = mutation.data.body as SetInfoPostResponse | undefined;
    if (!body?.username) return;
    const user = new SignedUser(body as unknown as SignedUserType);
    setCacheUser(user.id);
    hydrateQueryCache(user.id).finally(() => {
      setTimeout(() => setUserInfo(user), 500);
    });
  }, [email, mutation.data, setUserInfo]);

  const onClickSignUp = () => {
    if (email && passwordInput && passwordInput !== passwordConfirmInput) {
      setPasswordMismatch(true);
      return;
    }
    setPasswordMismatch(false);
    mutation.mutate({
      email: emailInput,
      token,
      username: usernameInput,
      password: passwordInput
    });
    if (email) window.name = "mail-confirm";
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onClickSignUp();
  };

  // Sign-up and reset set a password this server no longer signs in with.
  if (!getSignInMode().localLogin) return <Navigate to="/sign-in" replace />;

  return (
    <div className="container_login">
      <form onSubmit={onSubmit} noValidate>
        <div className="login_card">
          <h2 className="greeting">{copy.title}</h2>
          <p className="signup_intro">{copy.intro}</p>
          <div
            className={"info_message" + (status.isError ? " error" : "")}
            role={status.isError ? "alert" : "status"}
          >
            {status.message}
          </div>
          <label className="login_label" htmlFor="signup-email">
            Email address
          </label>
          <input
            id="signup-email"
            className="login_ui"
            type="email"
            autoComplete="email"
            value={emailInput}
            onChange={onChangeEmail}
            disabled={!!email}
          />
          {email ? (
            <>
              <label className="login_label" htmlFor="signup-username">
                Username
              </label>
              <input
                id="signup-username"
                className="login_ui"
                type="text"
                autoComplete="username"
                autoCapitalize="off"
                value={usernameInput}
                onChange={onChangeUsername}
                disabled={!!username}
              />
              <label className="login_label" htmlFor="signup-password">
                Password
              </label>
              <input
                id="signup-password"
                className="login_ui"
                type="password"
                autoComplete="new-password"
                value={passwordInput}
                onChange={onChangePassword}
              />
              <label className="login_label" htmlFor="signup-password-confirm">
                Confirm password
              </label>
              <input
                id="signup-password-confirm"
                className="login_ui"
                type="password"
                autoComplete="new-password"
                value={passwordConfirmInput}
                onChange={onChangePasswordConfirm}
              />
            </>
          ) : null}
          <button
            className="login_ui"
            type="submit"
            disabled={mutation.isLoading}
          >
            {email ? <UserEditIcon /> : <SignUpIcon />}
            <span>{copy.button}</span>
          </button>
          <div className="card_footer">
            <div className="footer_line">
              <span>Already have an account?</span>{" "}
              <Link to="/sign-in">Sign in</Link>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
};

export default SignUp;
